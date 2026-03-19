import { Effect, Ref } from "effect";
import { type Interaction, type Message } from "discord.js";
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";

import {
  buildQuestionAnswers,
  buildQuestionModal,
  clearQuestionDraft,
  createQuestionMessageCreate,
  createQuestionMessageEdit,
  parseQuestionActionId,
  QUESTION_OPTIONS_PER_PAGE,
  questionDrafts,
  questionInteractionReply,
  questionOptionPageCount,
  readQuestionModalValue,
  setQuestionCustomAnswer,
  setQuestionOptionSelection,
} from "@/discord/question-card.ts";
import {
  activateQuestionBatch,
  attachQuestionMessage,
  createQuestionWorkflowBatch,
  isPendingQuestionBatch,
  isTerminalQuestionBatch,
  persistQuestionBatchUpdate,
  questionBatchView,
  setQuestionBatchStatus,
  terminateQuestionBatch,
  type QuestionWorkflowBatch,
} from "@/sessions/question/question-workflow-state.ts";
import type { SessionContext } from "@/sessions/session-runtime.ts";
import {
  currentPromptReplyTargetMessage,
  questionUiFailureOutcome,
  type ActiveRun,
  type ChannelSession,
  type QuestionOutcome,
} from "@/sessions/session.ts";
import type { LoggerShape } from "@/util/logging.ts";

export type QuestionWorkflowEvent =
  | { type: "asked"; request: QuestionRequest }
  | { type: "replied"; requestId: string; answers: ReadonlyArray<QuestionAnswer> }
  | { type: "rejected"; requestId: string };

export type QuestionWorkflowSignal =
  | { type: "clear-run-interrupt" }
  | { type: "set-run-question-outcome"; outcome: QuestionOutcome };

export type QuestionWorkflow = {
  handleEvent: (
    event: QuestionWorkflowEvent,
  ) => Effect.Effect<ReadonlyArray<QuestionWorkflowSignal>, unknown>;
  handleInteraction: (
    interaction: Interaction,
  ) => Effect.Effect<ReadonlyArray<QuestionWorkflowSignal>, unknown>;
  hasPendingQuestions: () => Effect.Effect<boolean>;
  shutdown: () => Effect.Effect<ReadonlyArray<string>, unknown>;
  terminate: () => Effect.Effect<ReadonlyArray<QuestionWorkflowSignal>, unknown>;
};

type QuestionWorkflowDeps = {
  getSessionContext: () => Effect.Effect<SessionContext | null>;
  replyToQuestion: (
    session: ChannelSession["opencode"],
    requestID: string,
    answers: Array<QuestionAnswer>,
  ) => Effect.Effect<void, unknown>;
  rejectQuestion: (
    session: ChannelSession["opencode"],
    requestID: string,
  ) => Effect.Effect<void, unknown>;
  sendQuestionUiFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>;
  trackRequestId: (requestId: string) => Effect.Effect<void, unknown>;
  releaseRequestId: (requestId: string) => Effect.Effect<void, unknown>;
  onDrained: () => Effect.Effect<void, unknown>;
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

type PersistQuestionBatchResult =
  | { type: "updated"; batch: QuestionWorkflowBatch }
  | { type: "missing" }
  | { type: "conflict"; batch: QuestionWorkflowBatch };

const noSignals: ReadonlyArray<QuestionWorkflowSignal> = [];

const signal = <A extends QuestionWorkflowSignal>(value: A): ReadonlyArray<A> => [value];

const appendSignals = (
  left: ReadonlyArray<QuestionWorkflowSignal>,
  right: ReadonlyArray<QuestionWorkflowSignal>,
): ReadonlyArray<QuestionWorkflowSignal> => (left.length === 0 ? right : [...left, ...right]);

export const createQuestionWorkflow = (
  deps: QuestionWorkflowDeps,
): Effect.Effect<QuestionWorkflow> =>
  Effect.gen(function* () {
    const batchesRef = yield* Ref.make(new Map<string, QuestionWorkflowBatch>());

    const notifyIfDrained = () =>
      Ref.get(batchesRef).pipe(
        Effect.flatMap((batches) => (batches.size === 0 ? deps.onDrained() : Effect.void)),
      );

    const getQuestionBatch = (requestId: string) =>
      Ref.get(batchesRef).pipe(Effect.map((batches) => batches.get(requestId) ?? null));

    const updateQuestionBatch = (
      requestId: string,
      update: (batch: QuestionWorkflowBatch) => QuestionWorkflowBatch | null,
    ) =>
      Ref.modify(
        batchesRef,
        (current): readonly [QuestionWorkflowBatch | null, Map<string, QuestionWorkflowBatch>] => {
          const existing = current.get(requestId);
          if (!existing) {
            return [null, current];
          }

          const nextBatch = update(existing);
          const batches = new Map(current);
          if (nextBatch) {
            batches.set(requestId, nextBatch);
          } else {
            batches.delete(requestId);
          }
          return [nextBatch, batches];
        },
      );

    const removeQuestionBatch = (requestId: string) =>
      Ref.modify(
        batchesRef,
        (current): readonly [QuestionWorkflowBatch | null, Map<string, QuestionWorkflowBatch>] => {
          const existing = current.get(requestId) ?? null;
          if (!existing) {
            return [null, current];
          }

          const batches = new Map(current);
          batches.delete(requestId);
          return [existing, batches];
        },
      ).pipe(
        Effect.tap((batch) =>
          !batch
            ? Effect.void
            : deps
                .releaseRequestId(batch.domain.request.id)
                .pipe(Effect.andThen(notifyIfDrained())),
        ),
      );

    const tryPersistQuestionBatch = (
      requestId: string,
      expectedVersion: number,
      actorId: string,
      update: (batch: QuestionWorkflowBatch) => QuestionWorkflowBatch,
    ) =>
      Ref.modify(
        batchesRef,
        (current): readonly [PersistQuestionBatchResult, Map<string, QuestionWorkflowBatch>] => {
          const existing = current.get(requestId);
          if (!existing) {
            return [{ type: "missing" }, current];
          }
          if (existing.domain.version !== expectedVersion) {
            return [{ type: "conflict", batch: existing }, current];
          }

          const updated = persistQuestionBatchUpdate(existing, actorId, update);
          const batches = new Map(current);
          batches.set(requestId, updated);
          return [{ type: "updated", batch: updated }, batches];
        },
      );

    const hasPendingQuestions = () =>
      Ref.get(batchesRef).pipe(
        Effect.map((batches) => [...batches.values()].some(isPendingQuestionBatch)),
      );

    const editQuestionMessage = (batch: QuestionWorkflowBatch) => {
      if (batch.runtime.attachment._tag !== "attached") {
        return Effect.void;
      }

      const message = batch.runtime.attachment.message;
      return Effect.promise(() =>
        message.edit(createQuestionMessageEdit(questionBatchView(batch))),
      ).pipe(Effect.asVoid);
    };

    const replyToQuestionInteraction = (interaction: Interaction, message: string) => {
      if (
        !interaction.isButton() &&
        !interaction.isStringSelectMenu() &&
        !interaction.isModalSubmit()
      ) {
        return Effect.void;
      }
      if (interaction.replied || interaction.deferred) {
        return Effect.void;
      }
      return Effect.promise(() => interaction.reply(questionInteractionReply(message))).pipe(
        Effect.ignore,
      );
    };

    const replyToQuestionConflict = (interaction: Interaction, batch: QuestionWorkflowBatch) =>
      replyToQuestionInteraction(
        interaction,
        batch.runtime.lastModifiedBy && batch.runtime.lastModifiedBy !== interaction.user.id
          ? "Another user updated this question prompt before your action was applied. Review the latest card and try again."
          : "This question prompt changed before your action was applied. Review the latest card and try again.",
      );

    const finalizeBatchIfAttached = (batch: QuestionWorkflowBatch) =>
      !isTerminalQuestionBatch(batch) || batch.runtime.attachment._tag !== "attached"
        ? Effect.void
        : editQuestionMessage(batch).pipe(
            Effect.catch((error) =>
              deps.logger.warn("failed to edit finalized question batch", {
                channelId: batch.runtime.channelId,
                requestId: batch.domain.request.id,
                error: deps.formatError(error),
              }),
            ),
          );

    const attachPostedQuestionMessage = (requestId: string, message: Message) =>
      updateQuestionBatch(requestId, (current) =>
        attachQuestionMessage(
          current.domain.lifecycle === "posting" ? activateQuestionBatch(current) : current,
          message,
        ),
      );

    const finalizeQuestionBatch = (
      requestId: string,
      lifecycle: "answered" | "rejected",
      resolvedAnswers?: ReadonlyArray<QuestionAnswer>,
    ) =>
      Effect.gen(function* () {
        const batch = yield* updateQuestionBatch(requestId, (current) =>
          setQuestionBatchStatus(current, lifecycle, resolvedAnswers),
        );
        if (!batch) {
          return noSignals;
        }

        yield* finalizeBatchIfAttached(batch);
        yield* removeQuestionBatch(batch.domain.request.id).pipe(Effect.asVoid);
        return noSignals;
      });

    const updateInteraction = (interaction: Interaction, batch: QuestionWorkflowBatch) => {
      if (!interaction.isButton()) {
        return Effect.void;
      }
      return Effect.promise(() =>
        interaction.update(createQuestionMessageEdit(questionBatchView(batch))),
      );
    };

    const getQuestionSession = () =>
      deps.getSessionContext().pipe(Effect.map((context) => context?.session ?? null));

    const expireQuestionBatch = (requestId: string) =>
      updateQuestionBatch(requestId, (current) => terminateQuestionBatch(current));

    const submitQuestionBatch = (input: {
      interaction: Interaction;
      requestId: string;
      expectedVersion: number;
      actorId: string;
      answers: Array<QuestionAnswer>;
    }) =>
      Effect.gen(function* () {
        const submitting = yield* tryPersistQuestionBatch(
          input.requestId,
          input.expectedVersion,
          input.actorId,
          (current) => setQuestionBatchStatus(current, "submitting"),
        );
        if (submitting.type === "missing") {
          yield* replyToQuestionInteraction(input.interaction, "This question prompt has expired.");
          return noSignals;
        }
        if (submitting.type === "conflict") {
          yield* replyToQuestionConflict(input.interaction, submitting.batch);
          return noSignals;
        }

        const session = yield* getQuestionSession();
        if (!session) {
          const expired = yield* expireQuestionBatch(input.requestId);
          if (!expired) {
            yield* replyToQuestionInteraction(
              input.interaction,
              "This question prompt has expired.",
            );
            return noSignals;
          }
          yield* updateInteraction(input.interaction, expired);
          yield* removeQuestionBatch(input.requestId).pipe(Effect.asVoid);
          return noSignals;
        }
        yield* updateInteraction(input.interaction, submitting.batch);

        const submitResult = yield* deps
          .replyToQuestion(session.opencode, submitting.batch.domain.request.id, input.answers)
          .pipe(Effect.result);
        if (submitResult._tag === "Failure") {
          const restored = yield* updateQuestionBatch(input.requestId, (current) =>
            setQuestionBatchStatus(current, "active"),
          );
          if (restored) {
            yield* editQuestionMessage(restored).pipe(Effect.ignore);
          }
          if (input.interaction.isButton()) {
            const interaction = input.interaction;
            yield* Effect.promise(() =>
              interaction.followUp(
                questionInteractionReply(
                  `Failed to submit answers: ${deps.formatError(submitResult.failure)}`,
                ),
              ),
            ).pipe(Effect.ignore);
          }
          return noSignals;
        }

        return yield* finalizeQuestionBatch(
          submitting.batch.domain.request.id,
          "answered",
          input.answers,
        );
      });

    const rejectQuestionBatch = (input: {
      interaction: Interaction;
      requestId: string;
      expectedVersion: number;
      actorId: string;
    }) =>
      Effect.gen(function* () {
        const rejecting = yield* tryPersistQuestionBatch(
          input.requestId,
          input.expectedVersion,
          input.actorId,
          (current) => setQuestionBatchStatus(current, "submitting"),
        );
        if (rejecting.type === "missing") {
          yield* replyToQuestionInteraction(input.interaction, "This question prompt has expired.");
          return noSignals;
        }
        if (rejecting.type === "conflict") {
          yield* replyToQuestionConflict(input.interaction, rejecting.batch);
          return noSignals;
        }

        const session = yield* getQuestionSession();
        if (!session) {
          const expired = yield* expireQuestionBatch(input.requestId);
          if (!expired) {
            yield* replyToQuestionInteraction(
              input.interaction,
              "This question prompt has expired.",
            );
            return noSignals;
          }
          yield* updateInteraction(input.interaction, expired);
          yield* removeQuestionBatch(input.requestId).pipe(Effect.asVoid);
          return noSignals;
        }
        yield* updateInteraction(input.interaction, rejecting.batch);

        const rejectResult = yield* deps
          .rejectQuestion(session.opencode, rejecting.batch.domain.request.id)
          .pipe(Effect.result);
        if (rejectResult._tag === "Failure") {
          const restored = yield* updateQuestionBatch(input.requestId, (current) =>
            setQuestionBatchStatus(current, "active"),
          );
          if (restored) {
            yield* editQuestionMessage(restored).pipe(Effect.ignore);
          }
          if (input.interaction.isButton()) {
            const interaction = input.interaction;
            yield* Effect.promise(() =>
              interaction.followUp(
                questionInteractionReply(
                  `Failed to reject questions: ${deps.formatError(rejectResult.failure)}`,
                ),
              ),
            ).pipe(Effect.ignore);
          }
          return noSignals;
        }

        const finalizedSignals = yield* finalizeQuestionBatch(
          rejecting.batch.domain.request.id,
          "rejected",
        );
        return appendSignals(
          finalizedSignals,
          signal({
            type: "set-run-question-outcome",
            outcome: { _tag: "user-rejected" },
          }),
        );
      });

    const currentQuestionDraft = (batch: QuestionWorkflowBatch, questionIndex: number) =>
      batch.domain.drafts[questionIndex] ?? clearQuestionDraft();

    const applyQuestionUpdate = (
      interaction: Interaction,
      requestId: string,
      expectedVersion: number,
      update: (batch: QuestionWorkflowBatch) => QuestionWorkflowBatch,
    ) =>
      Effect.gen(function* () {
        if (!interaction.isButton() && !interaction.isStringSelectMenu()) {
          return;
        }

        const persisted = yield* tryPersistQuestionBatch(
          requestId,
          expectedVersion,
          interaction.user.id,
          update,
        );
        if (persisted.type === "missing") {
          yield* replyToQuestionInteraction(
            interaction,
            "This question prompt is no longer active.",
          );
          return;
        }
        if (persisted.type === "conflict") {
          yield* replyToQuestionConflict(interaction, persisted.batch);
          return;
        }

        yield* Effect.promise(() =>
          interaction.update(createQuestionMessageEdit(questionBatchView(persisted.batch))),
        );
      });

    const handleQuestionAsked = (
      session: ChannelSession,
      activeRun: ActiveRun,
      request: QuestionRequest,
    ) =>
      Effect.gen(function* () {
        const batch = yield* Ref.modify(
          batchesRef,
          (
            current,
          ): readonly [QuestionWorkflowBatch | null, Map<string, QuestionWorkflowBatch>] => {
            if (current.has(request.id)) {
              return [null, current];
            }

            const created = createQuestionWorkflowBatch({
              request,
              channelId: session.channelId,
              replyTargetMessage: currentPromptReplyTargetMessage(activeRun),
              drafts: questionDrafts(request),
            });
            const batches = new Map(current);
            batches.set(request.id, created);
            return [created, batches];
          },
        );
        if (!batch) {
          return noSignals;
        }

        yield* deps.trackRequestId(request.id);

        let signals = noSignals;
        if (activeRun.interruptRequested) {
          yield* deps.logger.info("question prompt superseded interrupt request", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            requestId: request.id,
          });
          signals = signal({ type: "clear-run-interrupt" });
        }

        const questionMessage = yield* Effect.tryPromise({
          try: () =>
            batch.runtime.replyTargetMessage.reply({
              ...createQuestionMessageCreate(questionBatchView(activateQuestionBatch(batch))),
              allowedMentions: { repliedUser: true, parse: ["users", "roles", "everyone"] },
            }),
          catch: (error) => error,
        }).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            onTimeout: () => Effect.fail(new Error("Timed out sending question batch to Discord")),
          }),
          Effect.result,
        );

        if (questionMessage._tag === "Success") {
          const attached = yield* attachPostedQuestionMessage(request.id, questionMessage.success);
          if (!attached) {
            return signals;
          }

          return signals;
        }

        yield* removeQuestionBatch(request.id);
        const questionUiFailure = deps.formatError(questionMessage.failure);

        yield* deps.logger.error("failed to post question batch", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          requestId: request.id,
          error: questionUiFailure,
        });

        const rejectResult = yield* deps
          .rejectQuestion(session.opencode, request.id)
          .pipe(Effect.result);
        if (rejectResult._tag === "Failure") {
          yield* deps.logger.error("failed to reject question batch after UI failure", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            requestId: request.id,
            error: deps.formatError(rejectResult.failure),
          });

          const failureReply = yield* deps
            .sendQuestionUiFailure(batch.runtime.replyTargetMessage, questionUiFailure)
            .pipe(Effect.result);
          if (failureReply._tag === "Failure") {
            yield* deps.logger.error("failed to send question UI failure message", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              requestId: request.id,
              error: deps.formatError(failureReply.failure),
            });
          }

          return appendSignals(
            signals,
            signal({
              type: "set-run-question-outcome",
              outcome: questionUiFailureOutcome(questionUiFailure, failureReply._tag === "Success"),
            }),
          );
        }

        return appendSignals(
          signals,
          signal({
            type: "set-run-question-outcome",
            outcome: questionUiFailureOutcome(questionUiFailure),
          }),
        );
      });

    const handleInteraction = (interaction: Interaction) =>
      Effect.gen(function* () {
        if (
          !interaction.isButton() &&
          !interaction.isStringSelectMenu() &&
          !interaction.isModalSubmit()
        ) {
          return noSignals;
        }

        const action = parseQuestionActionId(interaction.customId);
        if (!action) {
          return noSignals;
        }

        const batch = yield* getQuestionBatch(action.requestID);
        if (!batch) {
          yield* replyToQuestionInteraction(interaction, "This question prompt has expired.");
          return noSignals;
        }

        if (
          (interaction.isButton() || interaction.isStringSelectMenu()) &&
          batch.runtime.attachment._tag === "attached" &&
          interaction.message.id !== batch.runtime.attachment.message.id
        ) {
          yield* replyToQuestionInteraction(interaction, "This question prompt has been replaced.");
          return noSignals;
        }

        if (batch.domain.lifecycle !== "active") {
          yield* replyToQuestionInteraction(
            interaction,
            "This question prompt is already being finalized.",
          );
          return noSignals;
        }

        if (batch.domain.version !== action.version) {
          yield* replyToQuestionConflict(interaction, batch);
          return noSignals;
        }

        switch (action.kind) {
          case "question-prev":
            yield* applyQuestionUpdate(
              interaction,
              action.requestID,
              action.version,
              (current) => ({
                ...current,
                domain: {
                  ...current.domain,
                  page: Math.max(0, current.domain.page - 1),
                },
              }),
            );
            return noSignals;
          case "question-next":
            yield* applyQuestionUpdate(
              interaction,
              action.requestID,
              action.version,
              (current) => ({
                ...current,
                domain: {
                  ...current.domain,
                  page: Math.min(
                    current.domain.request.questions.length - 1,
                    current.domain.page + 1,
                  ),
                },
              }),
            );
            return noSignals;
          case "option-prev":
            yield* applyQuestionUpdate(interaction, action.requestID, action.version, (current) => {
              const optionPages = [...current.domain.optionPages];
              optionPages[action.questionIndex] = Math.max(
                0,
                (optionPages[action.questionIndex] ?? 0) - 1,
              );
              return {
                ...current,
                domain: {
                  ...current.domain,
                  page: action.questionIndex,
                  optionPages,
                },
              };
            });
            return noSignals;
          case "option-next":
            yield* applyQuestionUpdate(interaction, action.requestID, action.version, (current) => {
              const question = current.domain.request.questions[action.questionIndex];
              if (!question) {
                return current;
              }
              const maxOptionPage = Math.max(0, questionOptionPageCount(question) - 1);
              const optionPages = [...current.domain.optionPages];
              optionPages[action.questionIndex] = Math.min(
                maxOptionPage,
                (optionPages[action.questionIndex] ?? 0) + 1,
              );
              return {
                ...current,
                domain: {
                  ...current.domain,
                  page: action.questionIndex,
                  optionPages,
                },
              };
            });
            return noSignals;
          case "clear":
            yield* applyQuestionUpdate(interaction, action.requestID, action.version, (current) => {
              const drafts = [...current.domain.drafts];
              drafts[action.questionIndex] = clearQuestionDraft();
              return {
                ...current,
                domain: {
                  ...current.domain,
                  page: action.questionIndex,
                  drafts,
                },
              };
            });
            return noSignals;
          case "select":
            if (!interaction.isStringSelectMenu()) {
              return noSignals;
            }
            yield* applyQuestionUpdate(interaction, action.requestID, action.version, (current) => {
              const question = current.domain.request.questions[action.questionIndex];
              if (!question) {
                return current;
              }

              const page = current.domain.optionPages[action.questionIndex] ?? 0;
              const visibleOptions = question.options
                .slice(
                  page * QUESTION_OPTIONS_PER_PAGE,
                  page * QUESTION_OPTIONS_PER_PAGE + QUESTION_OPTIONS_PER_PAGE,
                )
                .map((option) => option.label);
              const drafts = [...current.domain.drafts];
              drafts[action.questionIndex] = setQuestionOptionSelection({
                question,
                draft: currentQuestionDraft(current, action.questionIndex),
                visibleOptions,
                selectedOptions: interaction.values,
              });
              return {
                ...current,
                domain: {
                  ...current.domain,
                  page: action.questionIndex,
                  drafts,
                },
              };
            });
            return noSignals;
          case "custom":
            if (!interaction.isButton()) {
              return noSignals;
            }
            {
              const question = batch.domain.request.questions[action.questionIndex];
              if (!question || question.custom === false) {
                yield* replyToQuestionInteraction(
                  interaction,
                  "This question does not allow a custom answer.",
                );
                return noSignals;
              }

              yield* Effect.promise(() =>
                interaction.showModal(
                  buildQuestionModal({
                    requestID: action.requestID,
                    version: action.version,
                    questionIndex: action.questionIndex,
                    question,
                    draft: currentQuestionDraft(batch, action.questionIndex),
                  }),
                ),
              );
              return noSignals;
            }
          case "modal":
            if (!interaction.isModalSubmit()) {
              return noSignals;
            }
            {
              const question = batch.domain.request.questions[action.questionIndex];
              if (!question || question.custom === false) {
                yield* replyToQuestionInteraction(
                  interaction,
                  "This question does not allow a custom answer.",
                );
                return noSignals;
              }

              const customAnswer = readQuestionModalValue(interaction);
              if (!customAnswer) {
                yield* Effect.promise(() =>
                  interaction.reply(questionInteractionReply("Custom answer cannot be empty.")),
                ).pipe(Effect.ignore);
                return noSignals;
              }

              const updated = yield* tryPersistQuestionBatch(
                action.requestID,
                action.version,
                interaction.user.id,
                (current) => {
                  const drafts = [...current.domain.drafts];
                  drafts[action.questionIndex] = setQuestionCustomAnswer(
                    question,
                    currentQuestionDraft(current, action.questionIndex),
                    customAnswer,
                  );
                  return {
                    ...current,
                    domain: {
                      ...current.domain,
                      page: action.questionIndex,
                      drafts,
                    },
                  };
                },
              );
              if (updated.type === "missing") {
                yield* replyToQuestionInteraction(interaction, "This question prompt has expired.");
                return noSignals;
              }
              if (updated.type === "conflict") {
                yield* replyToQuestionConflict(interaction, updated.batch);
                return noSignals;
              }

              yield* editQuestionMessage(updated.batch).pipe(
                Effect.catch((error) =>
                  deps.logger.warn("failed to edit question batch after modal submit", {
                    channelId: updated.batch.runtime.channelId,
                    requestId: updated.batch.domain.request.id,
                    error: deps.formatError(error),
                  }),
                ),
              );
              yield* Effect.promise(() => interaction.deferUpdate()).pipe(Effect.ignore);
              return noSignals;
            }
          case "submit":
            if (!interaction.isButton()) {
              return noSignals;
            }
            return yield* submitQuestionBatch({
              interaction,
              requestId: action.requestID,
              expectedVersion: action.version,
              actorId: interaction.user.id,
              answers: buildQuestionAnswers(batch.domain.request, batch.domain.drafts),
            });
          case "reject":
            if (!interaction.isButton()) {
              return noSignals;
            }
            return yield* rejectQuestionBatch({
              interaction,
              requestId: action.requestID,
              expectedVersion: action.version,
              actorId: interaction.user.id,
            });
        }
      });

    const expireMatchingBatches = (includeRequestIds = false) =>
      Effect.gen(function* () {
        const { terminated, requestIds, releasedRequestIds } = yield* Ref.modify(
          batchesRef,
          (
            current,
          ): readonly [
            {
              terminated: QuestionWorkflowBatch[];
              requestIds: string[];
              releasedRequestIds: string[];
            },
            Map<string, QuestionWorkflowBatch>,
          ] => {
            const batches = new Map(current);
            const terminated: QuestionWorkflowBatch[] = [];
            const requestIds: string[] = [];
            const releasedRequestIds: string[] = [];

            for (const [requestId, batch] of current.entries()) {
              if (!isPendingQuestionBatch(batch)) {
                continue;
              }

              const expired = terminateQuestionBatch(batch);
              terminated.push(expired);
              if (includeRequestIds) {
                requestIds.push(requestId);
              }

              batches.delete(requestId);
              releasedRequestIds.push(requestId);
            }

            return [{ terminated, requestIds, releasedRequestIds }, batches];
          },
        );

        yield* Effect.forEach(releasedRequestIds, deps.releaseRequestId, {
          concurrency: "unbounded",
          discard: true,
        });
        yield* Effect.forEach(
          terminated,
          (batch) =>
            batch.runtime.attachment._tag === "attached"
              ? editQuestionMessage(batch).pipe(
                  Effect.catch((error) =>
                    deps.logger.warn("failed to terminate question batch message", {
                      channelId: batch.runtime.channelId,
                      requestId: batch.domain.request.id,
                      error: deps.formatError(error),
                    }),
                  ),
                )
              : Effect.void,
          { concurrency: "unbounded", discard: true },
        );
        yield* notifyIfDrained();

        return requestIds;
      });

    const terminate = () => expireMatchingBatches().pipe(Effect.as(noSignals));

    return {
      handleEvent: (event) => {
        switch (event.type) {
          case "asked":
            return deps.getSessionContext().pipe(
              Effect.flatMap((context) => {
                if (!context?.activeRun) {
                  return Effect.succeed(noSignals);
                }
                return handleQuestionAsked(context.session, context.activeRun, event.request);
              }),
            );
          case "replied":
            return finalizeQuestionBatch(event.requestId, "answered", event.answers);
          case "rejected":
            return finalizeQuestionBatch(event.requestId, "rejected");
        }
      },
      handleInteraction,
      hasPendingQuestions,
      shutdown: () => expireMatchingBatches(true),
      terminate,
    } satisfies QuestionWorkflow;
  });
