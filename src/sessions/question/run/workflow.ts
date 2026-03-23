import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";
import { Effect, Option, Ref, Result } from "effect";
import { type Interaction, type Message } from "discord.js";

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
import type { OpencodeServiceShape } from "@/opencode/service.ts";
import {
  activateQuestionBatch,
  attachQuestionMessage,
  createQuestionWorkflowBatch,
  isAttachedQuestionBatchAttachment,
  isPendingQuestionBatch,
  isTerminalQuestionBatch,
  persistQuestionBatchUpdate,
  questionBatchView,
  setQuestionBatchStatus,
  terminateQuestionBatch,
  type QuestionWorkflowBatch,
} from "@/sessions/question/batch-state.ts";
import type { QuestionRunWorkflow } from "@/sessions/question/types.ts";
import {
  applyQuestionSignals,
  questionTypingAction,
  runQuestionTypingAction,
  type QuestionWorkflowSignal,
} from "@/sessions/question/run/signals.ts";
import { currentPromptReplyTargetMessage, readRunInterrupt } from "@/sessions/run/active-state.ts";
import {
  questionUiFailureOutcome,
  userRejectedQuestionOutcome,
  type ActiveRun,
  type ChannelSession,
} from "@/sessions/types.ts";
import { formatError } from "@/util/errors.ts";
import type { LoggerShape } from "@/util/logging.ts";

type QuestionSignals = ReadonlyArray<QuestionWorkflowSignal>;
type Batch = QuestionWorkflowBatch;
type QuestionRunWorkflowState = {
  stopped: boolean;
  typingPaused: boolean;
  batches: Map<string, Batch>;
};
type PersistQuestionBatchResult =
  | { type: "updated"; batch: Batch }
  | { type: "missing" }
  | { type: "conflict"; batch: Batch };
type RemoteQuestionAction = {
  interaction: Interaction;
  requestId: string;
  expectedVersion: number;
  invoke: (requestId: string) => Effect.Effect<void, unknown>;
  followUpFailure: (error: unknown) => string;
  onSuccess: (batch: Batch) => Effect.Effect<QuestionSignals, unknown>;
};

const SHUTDOWN_QUESTION_RPC_TIMEOUT = "1 second";
const questionRuntimeError = (message: string, cause?: unknown) =>
  Object.assign(new Error(message), cause === undefined ? {} : { cause });

const noSignals: QuestionSignals = [];
const signal = <A extends QuestionWorkflowSignal>(value: A): ReadonlyArray<A> => [value];
const appendSignals = (left: QuestionSignals, right: QuestionSignals): QuestionSignals =>
  left.length === 0 ? right : [...left, ...right];
const emptyState = (): QuestionRunWorkflowState => ({
  stopped: false,
  typingPaused: false,
  batches: new Map(),
});

export const makeQuestionRunWorkflow = (input: {
  session: ChannelSession;
  activeRun: ActiveRun;
  sendQuestionUiFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>;
  logger: LoggerShape;
  opencode: Pick<OpencodeServiceShape, "replyToQuestion" | "rejectQuestion">;
}): Effect.Effect<QuestionRunWorkflow, never> =>
  Effect.gen(function* () {
    const { session, activeRun, sendQuestionUiFailure, logger, opencode } = input;
    const sessionId = session.opencode.sessionId;
    const stateRef = yield* Ref.make<QuestionRunWorkflowState>(emptyState());

    const readState = () => Ref.get(stateRef);
    const hasPendingQuestions = () =>
      readState().pipe(
        Effect.map((state) => [...state.batches.values()].some(isPendingQuestionBatch)),
      );

    const syncTyping = () =>
      hasPendingQuestions().pipe(
        Effect.flatMap((pending) =>
          Ref.modify(stateRef, (current) => {
            const wasPaused = current.typingPaused;
            return [
              { pending, wasPaused },
              { ...current, typingPaused: pending },
            ] as const;
          }).pipe(
            Effect.flatMap(({ pending, wasPaused }) =>
              runQuestionTypingAction({
                sessionId,
                activeRun,
                action: questionTypingAction(activeRun, pending, wasPaused),
                logger,
              }),
            ),
          ),
        ),
      );

    const routeSignals = (effect: Effect.Effect<QuestionSignals, unknown>) =>
      effect.pipe(
        Effect.flatMap((signals) => applyQuestionSignals(activeRun, signals)),
        Effect.andThen(syncTyping()),
      );

    const getQuestionBatch = (requestId: string) =>
      readState().pipe(Effect.map((state) => state.batches.get(requestId) ?? null));

    const deleteQuestionBatch = (requestId: string) =>
      Ref.modify(stateRef, (current): readonly [Batch | null, QuestionRunWorkflowState] => {
        const batch = current.batches.get(requestId) ?? null;
        if (!batch) {
          return [null, current];
        }

        const batches = new Map(current.batches);
        batches.delete(requestId);
        return [batch, { ...current, batches }];
      });

    const updateQuestionBatch = (requestId: string, update: (batch: Batch) => Batch | null) =>
      Ref.modify(stateRef, (current): readonly [Batch | null, QuestionRunWorkflowState] => {
        const existing = current.batches.get(requestId);
        if (!existing) {
          return [null, current];
        }

        const nextBatch = update(existing);
        const batches = new Map(current.batches);
        if (nextBatch) {
          batches.set(requestId, nextBatch);
        } else {
          batches.delete(requestId);
        }

        return [nextBatch, { ...current, batches }];
      });

    const tryPersistQuestionBatch = (
      requestId: string,
      expectedVersion: number,
      actorId: string,
      update: (batch: Batch) => Batch,
    ) =>
      Ref.modify(
        stateRef,
        (current): readonly [PersistQuestionBatchResult, QuestionRunWorkflowState] => {
          const existing = current.batches.get(requestId);
          if (!existing) {
            return [{ type: "missing" }, current];
          }
          if (existing.domain.version !== expectedVersion) {
            return [{ type: "conflict", batch: existing }, current];
          }

          const batches = new Map(current.batches);
          const batch = persistQuestionBatchUpdate(existing, actorId, update);
          batches.set(requestId, batch);
          return [
            { type: "updated", batch },
            { ...current, batches },
          ];
        },
      );

    const expirePendingBatches = (includeRequestIds = false) =>
      Ref.modify(
        stateRef,
        (
          current,
        ): readonly [{ terminated: Batch[]; requestIds: string[] }, QuestionRunWorkflowState] => {
          const batches = new Map(current.batches);
          const terminated: Batch[] = [];
          const requestIds: string[] = [];

          for (const [requestId, batch] of current.batches) {
            if (!isPendingQuestionBatch(batch)) {
              continue;
            }
            terminated.push(terminateQuestionBatch(batch));
            if (includeRequestIds) {
              requestIds.push(requestId);
            }
            batches.delete(requestId);
          }

          return [
            { terminated, requestIds },
            { ...current, batches },
          ];
        },
      );

    const markStopped = () => Ref.update(stateRef, (current) => ({ ...current, stopped: true }));

    const editQuestionMessage = (batch: Batch) => {
      const attachment = batch.runtime.attachment;
      return !isAttachedQuestionBatchAttachment(attachment)
        ? Effect.void
        : Effect.tryPromise({
            try: () => attachment.message.edit(createQuestionMessageEdit(questionBatchView(batch))),
            catch: (cause) => questionRuntimeError(formatError(cause), cause),
          }).pipe(Effect.asVoid);
    };

    const replyToQuestionInteraction = (interaction: Interaction, message: string) =>
      !interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()
        ? Effect.void
        : interaction.replied || interaction.deferred
          ? Effect.void
          : Effect.promise(() => interaction.reply(questionInteractionReply(message))).pipe(
              Effect.ignore,
            );

    const replyToQuestionConflict = (interaction: Interaction, batch: Batch) =>
      replyToQuestionInteraction(
        interaction,
        batch.runtime.lastModifiedBy && batch.runtime.lastModifiedBy !== interaction.user.id
          ? "Another user updated this question prompt before your action was applied. Review the latest card and try again."
          : "This question prompt changed before your action was applied. Review the latest card and try again.",
      );

    const editQuestionMessageLogged = (batch: Batch, failureMessage: string) =>
      editQuestionMessage(batch).pipe(
        Effect.catch((error) =>
          logger.warn(failureMessage, {
            channelId: batch.runtime.channelId,
            requestId: batch.domain.request.id,
            error: formatError(error),
          }),
        ),
      );

    const finalizeBatchIfAttached = (batch: Batch) =>
      !isTerminalQuestionBatch(batch) ||
      !isAttachedQuestionBatchAttachment(batch.runtime.attachment)
        ? Effect.void
        : editQuestionMessageLogged(batch, "failed to edit finalized question batch");

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
        yield* deleteQuestionBatch(requestId).pipe(Effect.asVoid);
        return noSignals;
      });

    const updateInteraction = (interaction: Interaction, batch: Batch) =>
      !interaction.isButton() && !interaction.isStringSelectMenu()
        ? Effect.void
        : Effect.promise(() =>
            interaction.update(createQuestionMessageEdit(questionBatchView(batch))),
          );

    const persistQuestionBatchOrReply = (input: {
      interaction: Interaction;
      requestId: string;
      expectedVersion: number;
      update: (batch: Batch) => Batch;
      missingMessage: string;
    }) =>
      tryPersistQuestionBatch(
        input.requestId,
        input.expectedVersion,
        input.interaction.user.id,
        input.update,
      ).pipe(
        Effect.flatMap((result) => {
          if (result.type === "missing") {
            return replyToQuestionInteraction(input.interaction, input.missingMessage).pipe(
              Effect.as(null),
            );
          }
          if (result.type === "conflict") {
            return replyToQuestionConflict(input.interaction, result.batch).pipe(Effect.as(null));
          }
          return Effect.succeed(result.batch);
        }),
      );

    const applyQuestionUpdate = (
      interaction: Interaction,
      requestId: string,
      expectedVersion: number,
      update: (batch: Batch) => Batch,
    ) =>
      Effect.gen(function* () {
        if (!interaction.isButton() && !interaction.isStringSelectMenu()) {
          return;
        }

        const persisted = yield* persistQuestionBatchOrReply({
          interaction,
          requestId,
          expectedVersion,
          update,
          missingMessage: "This question prompt is no longer active.",
        });
        if (!persisted) {
          return;
        }

        yield* updateInteraction(interaction, persisted);
      });

    const routeQuestionUpdate = <A extends { requestID: string; version: number }>(
      interaction: Interaction,
      action: A,
      update: (batch: Batch) => Batch,
    ) =>
      applyQuestionUpdate(interaction, action.requestID, action.version, update).pipe(
        Effect.asVoid,
      );

    const setQuestionDraft = (
      batch: Batch,
      questionIndex: number,
      draft: Batch["domain"]["drafts"][number],
    ): Batch => {
      const drafts = [...batch.domain.drafts];
      drafts[questionIndex] = draft;
      return {
        ...batch,
        domain: {
          ...batch.domain,
          page: questionIndex,
          drafts,
        },
      };
    };

    const requireCustomQuestion = (
      interaction: Interaction,
      batch: Batch,
      questionIndex: number,
    ) => {
      const question = batch.domain.request.questions[questionIndex];
      return !question || question.custom === false
        ? replyToQuestionInteraction(
            interaction,
            "This question does not allow a custom answer.",
          ).pipe(Effect.as(null))
        : Effect.succeed(question);
    };

    const finalizeRemoteQuestionBatch = (input: RemoteQuestionAction) =>
      Effect.gen(function* () {
        const pending = yield* persistQuestionBatchOrReply({
          interaction: input.interaction,
          requestId: input.requestId,
          expectedVersion: input.expectedVersion,
          update: (current) => setQuestionBatchStatus(current, "submitting"),
          missingMessage: "This question prompt has expired.",
        });
        if (!pending) {
          return noSignals;
        }

        yield* updateInteraction(input.interaction, pending);

        return yield* input.invoke(pending.domain.request.id).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                const restored = yield* updateQuestionBatch(input.requestId, (current) =>
                  setQuestionBatchStatus(current, "active"),
                );
                if (restored) {
                  yield* editQuestionMessage(restored).pipe(Effect.ignore);
                }
                const interaction = input.interaction;
                if (interaction.isButton()) {
                  yield* Effect.promise(() =>
                    interaction.followUp(questionInteractionReply(input.followUpFailure(error))),
                  ).pipe(Effect.ignore);
                }
                return noSignals;
              }),
            onSuccess: () => input.onSuccess(pending),
          }),
        );
      });

    const currentQuestionDraft = (batch: Batch, questionIndex: number) =>
      batch.domain.drafts[questionIndex] ?? clearQuestionDraft();

    const handleQuestionAsked = (request: QuestionRequest) =>
      Effect.gen(function* () {
        const batch = yield* Ref.modify(
          stateRef,
          (current): readonly [Batch | null, QuestionRunWorkflowState] => {
            if (current.stopped || current.batches.has(request.id)) {
              return [null, current];
            }

            const created = createQuestionWorkflowBatch({
              sessionId,
              request,
              channelId: session.channelId,
              replyTargetMessage: currentPromptReplyTargetMessage(activeRun),
              drafts: questionDrafts(request),
            });
            const batches = new Map(current.batches);
            batches.set(request.id, created);
            return [created, { ...current, batches }];
          },
        );
        if (!batch) {
          return noSignals;
        }

        let signals = noSignals;
        if (readRunInterrupt(activeRun).requested) {
          yield* logger.info("question prompt superseded interrupt request", {
            channelId: session.channelId,
            sessionId,
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
          catch: (cause) => questionRuntimeError(formatError(cause), cause),
        }).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            onTimeout: () =>
              Effect.fail(questionRuntimeError("Timed out sending question batch to Discord")),
          }),
          Effect.result,
        );

        if (Result.isSuccess(questionMessage)) {
          yield* attachPostedQuestionMessage(request.id, questionMessage.success);
          return signals;
        }

        yield* deleteQuestionBatch(request.id);
        const questionUiFailure = formatError(questionMessage.failure);

        yield* logger.error("failed to post question batch", {
          channelId: session.channelId,
          sessionId,
          requestId: request.id,
          error: questionUiFailure,
        });

        const rejectResult = yield* opencode
          .rejectQuestion(session.opencode, request.id)
          .pipe(Effect.result);
        if (Result.isFailure(rejectResult)) {
          yield* logger.error("failed to reject question batch after UI failure", {
            channelId: session.channelId,
            sessionId,
            requestId: request.id,
            error: formatError(rejectResult.failure),
          });

          const failureReply = yield* sendQuestionUiFailure(
            batch.runtime.replyTargetMessage,
            questionUiFailure,
          ).pipe(Effect.result);
          if (Result.isFailure(failureReply)) {
            yield* logger.error("failed to send question UI failure message", {
              channelId: session.channelId,
              sessionId,
              requestId: request.id,
              error: formatError(failureReply.failure),
            });
          }

          return appendSignals(
            signals,
            signal({
              type: "set-run-question-outcome",
              outcome: questionUiFailureOutcome(questionUiFailure, Result.isSuccess(failureReply)),
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

    const rejectQuestionIdsForShutdown = (requestIds: ReadonlyArray<string>) =>
      requestIds.length === 0
        ? Effect.void
        : Effect.forEach(
            requestIds,
            (requestId) =>
              opencode.rejectQuestion(session.opencode, requestId).pipe(
                Effect.timeoutOption(SHUTDOWN_QUESTION_RPC_TIMEOUT),
                Effect.flatMap((result) =>
                  Option.isSome(result)
                    ? Effect.void
                    : Effect.fail(
                        questionRuntimeError(`Timed out rejecting question ${requestId}`),
                      ),
                ),
                Effect.result,
              ),
            { concurrency: "unbounded", discard: false },
          ).pipe(
            Effect.flatMap((results) => {
              const failure = results.find(Result.isFailure);
              if (!failure) {
                return Effect.void;
              }

              return logger
                .warn("question rejection was unresponsive during shutdown", {
                  sessionId,
                  error: formatError(failure.failure),
                })
                .pipe(Effect.andThen(session.opencode.close()));
            }),
          );

    const editAttachedQuestionBatches = (batches: ReadonlyArray<Batch>) =>
      Effect.forEach(
        batches,
        (batch) =>
          !isAttachedQuestionBatchAttachment(batch.runtime.attachment)
            ? Effect.void
            : editQuestionMessageLogged(batch, "failed to terminate question batch message"),
        { concurrency: "unbounded", discard: true },
      );

    return {
      handleEvent: (event) =>
        readState().pipe(
          Effect.flatMap((state) => {
            if (state.stopped || event.sessionId !== sessionId) {
              return Effect.void;
            }

            switch (event.type) {
              case "asked":
                return routeSignals(handleQuestionAsked(event.request));
              case "replied":
                return routeSignals(
                  finalizeQuestionBatch(event.requestId, "answered", event.answers),
                );
              case "rejected":
                return routeSignals(finalizeQuestionBatch(event.requestId, "rejected"));
            }
          }),
        ),
      routeInteraction: (interaction) =>
        Effect.gen(function* () {
          if (
            !interaction.isButton() &&
            !interaction.isStringSelectMenu() &&
            !interaction.isModalSubmit()
          ) {
            return;
          }

          const action = parseQuestionActionId(interaction.customId);
          if (!action || action.sessionID !== sessionId) {
            return;
          }

          const batch = yield* getQuestionBatch(action.requestID);
          if (!batch) {
            yield* replyToQuestionInteraction(interaction, "This question prompt has expired.");
            return;
          }

          if (
            (interaction.isButton() || interaction.isStringSelectMenu()) &&
            isAttachedQuestionBatchAttachment(batch.runtime.attachment) &&
            interaction.message.id !== batch.runtime.attachment.message.id
          ) {
            yield* replyToQuestionInteraction(
              interaction,
              "This question prompt has been replaced.",
            );
            return;
          }

          if (batch.domain.lifecycle !== "active") {
            yield* replyToQuestionInteraction(
              interaction,
              "This question prompt is already being finalized.",
            );
            return;
          }

          if (batch.domain.version !== action.version) {
            yield* replyToQuestionConflict(interaction, batch);
            return;
          }

          switch (action.kind) {
            case "question-prev":
            case "question-next":
              return yield* routeQuestionUpdate(interaction, action, (current) => ({
                ...current,
                domain: {
                  ...current.domain,
                  page:
                    action.kind === "question-prev"
                      ? Math.max(0, current.domain.page - 1)
                      : Math.min(
                          current.domain.request.questions.length - 1,
                          current.domain.page + 1,
                        ),
                },
              }));
            case "option-prev":
            case "option-next":
              return yield* routeQuestionUpdate(interaction, action, (current) => {
                const question = current.domain.request.questions[action.questionIndex];
                if (!question && action.kind === "option-next") {
                  return current;
                }

                const optionPages = [...current.domain.optionPages];
                optionPages[action.questionIndex] =
                  action.kind === "option-prev"
                    ? Math.max(0, (optionPages[action.questionIndex] ?? 0) - 1)
                    : Math.min(
                        Math.max(0, questionOptionPageCount(question!) - 1),
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
            case "clear":
              return yield* routeQuestionUpdate(interaction, action, (current) =>
                setQuestionDraft(current, action.questionIndex, clearQuestionDraft()),
              );
            case "select":
              if (!interaction.isStringSelectMenu()) {
                return;
              }
              return yield* routeQuestionUpdate(interaction, action, (current) => {
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
                return setQuestionDraft(
                  current,
                  action.questionIndex,
                  setQuestionOptionSelection({
                    question,
                    draft: currentQuestionDraft(current, action.questionIndex),
                    visibleOptions,
                    selectedOptions: interaction.values,
                  }),
                );
              });
            case "custom": {
              if (!interaction.isButton()) {
                return;
              }

              const question = yield* requireCustomQuestion(
                interaction,
                batch,
                action.questionIndex,
              );
              if (!question) {
                return;
              }

              yield* Effect.promise(() =>
                interaction.showModal(
                  buildQuestionModal({
                    sessionID: action.sessionID,
                    requestID: action.requestID,
                    version: action.version,
                    questionIndex: action.questionIndex,
                    question,
                    draft: currentQuestionDraft(batch, action.questionIndex),
                  }),
                ),
              );
              return;
            }
            case "modal": {
              if (!interaction.isModalSubmit()) {
                return;
              }

              const question = yield* requireCustomQuestion(
                interaction,
                batch,
                action.questionIndex,
              );
              if (!question) {
                return;
              }

              const customAnswer = readQuestionModalValue(interaction);
              if (!customAnswer) {
                yield* Effect.promise(() =>
                  interaction.reply(questionInteractionReply("Custom answer cannot be empty.")),
                ).pipe(Effect.ignore);
                return;
              }

              const updated = yield* persistQuestionBatchOrReply({
                interaction,
                requestId: action.requestID,
                expectedVersion: action.version,
                update: (current) =>
                  setQuestionDraft(
                    current,
                    action.questionIndex,
                    setQuestionCustomAnswer(
                      question,
                      currentQuestionDraft(current, action.questionIndex),
                      customAnswer,
                    ),
                  ),
                missingMessage: "This question prompt has expired.",
              });
              if (!updated) {
                return;
              }

              yield* editQuestionMessageLogged(
                updated,
                "failed to edit question batch after modal submit",
              );
              yield* Effect.promise(() => interaction.deferUpdate()).pipe(Effect.ignore);
              return;
            }
            case "submit":
            case "reject":
              if (!interaction.isButton()) {
                return;
              }
              return yield* routeSignals(
                finalizeRemoteQuestionBatch(
                  action.kind === "submit"
                    ? {
                        interaction,
                        requestId: action.requestID,
                        expectedVersion: action.version,
                        invoke: (requestId) =>
                          opencode.replyToQuestion(
                            session.opencode,
                            requestId,
                            buildQuestionAnswers(batch.domain.request, batch.domain.drafts),
                          ),
                        followUpFailure: (error) =>
                          `Failed to submit answers: ${formatError(error)}`,
                        onSuccess: () =>
                          finalizeQuestionBatch(
                            action.requestID,
                            "answered",
                            buildQuestionAnswers(batch.domain.request, batch.domain.drafts),
                          ),
                      }
                    : {
                        interaction,
                        requestId: action.requestID,
                        expectedVersion: action.version,
                        invoke: (requestId) => opencode.rejectQuestion(session.opencode, requestId),
                        followUpFailure: (error) =>
                          `Failed to reject questions: ${formatError(error)}`,
                        onSuccess: () =>
                          finalizeQuestionBatch(action.requestID, "rejected").pipe(
                            Effect.map((signals) =>
                              appendSignals(
                                signals,
                                signal({
                                  type: "set-run-question-outcome",
                                  outcome: userRejectedQuestionOutcome(),
                                }),
                              ),
                            ),
                          ),
                      },
                ),
              );
          }
        }),
      hasPendingQuestions,
      terminate: () =>
        expirePendingBatches().pipe(
          Effect.tap(({ terminated }) => editAttachedQuestionBatches(terminated)),
          Effect.andThen(syncTyping()),
        ),
      shutdown: () =>
        markStopped().pipe(
          Effect.andThen(expirePendingBatches(true)),
          Effect.tap(({ terminated }) => editAttachedQuestionBatches(terminated)),
          Effect.flatMap(({ requestIds }) => rejectQuestionIdsForShutdown(requestIds)),
          Effect.andThen(syncTyping()),
        ),
    } satisfies QuestionRunWorkflow;
  });
