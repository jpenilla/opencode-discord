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
  type QuestionBatchCardStatus,
  type QuestionDraft,
} from "@/discord/question-card.ts";
import { setQuestionBatchStatus, terminateQuestionBatch } from "@/sessions/question-batch-state.ts";
import { rejectQuestionBatch, submitQuestionBatch } from "@/sessions/question-submission.ts";
import type { SessionContext } from "@/sessions/session-lifecycle.ts";
import {
  currentPromptReplyTargetMessage,
  questionUiFailureOutcome,
  type ActiveRun,
  type ChannelSession,
} from "@/sessions/session.ts";
import type { LoggerShape } from "@/util/logging.ts";

type PendingQuestionBatch = {
  request: QuestionRequest;
  session: ChannelSession;
  version: number;
  lastModifiedBy: string | null;
  message: Message | null;
  page: number;
  optionPages: number[];
  drafts: QuestionDraft[];
  status: QuestionBatchCardStatus;
  resolvedAnswers?: Array<QuestionAnswer>;
};

export type QuestionCoordinatorEvent =
  | {
      type: "asked";
      sessionId: string;
      request: QuestionRequest;
    }
  | {
      type: "replied";
      sessionId: string;
      requestId: string;
      answers: ReadonlyArray<QuestionAnswer>;
    }
  | {
      type: "rejected";
      sessionId: string;
      requestId: string;
    };

export type QuestionCoordinator = {
  handleEvent: (event: QuestionCoordinatorEvent) => Effect.Effect<void, unknown>;
  handleInteraction: (interaction: Interaction) => Effect.Effect<void, unknown>;
  hasPendingQuestionsForSession: (sessionId: string) => Effect.Effect<boolean>;
  beginShutdown: () => Effect.Effect<void, unknown>;
  getPendingRequestIdsForSession: (sessionId: string) => Effect.Effect<ReadonlyArray<string>>;
  markShutdownRejectedRequests: (requestIds: ReadonlyArray<string>) => Effect.Effect<void, unknown>;
  terminateForSession: (sessionId: string) => Effect.Effect<void, unknown>;
  shutdown: () => Effect.Effect<void, unknown>;
};

type QuestionCoordinatorDeps = {
  getSessionContext: (sessionId: string) => Effect.Effect<SessionContext | null>;
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
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

const questionBatchView = (batch: PendingQuestionBatch) => ({
  request: batch.request,
  version: batch.version,
  page: batch.page,
  optionPages: batch.optionPages,
  drafts: batch.drafts,
  status: batch.status,
  resolvedAnswers: batch.resolvedAnswers,
});

export const createQuestionCoordinator = (
  deps: QuestionCoordinatorDeps,
): Effect.Effect<QuestionCoordinator> =>
  Effect.gen(function* () {
    const batchesRef = yield* Ref.make(new Map<string, PendingQuestionBatch>());
    const detachedFinalizedBatchesRef = yield* Ref.make(new Map<string, PendingQuestionBatch>());
    const shutdownRejectedRequestIdsRef = yield* Ref.make(new Set<string>());
    const shutdownStartedRef = yield* Ref.make(false);

    type PersistQuestionBatchResult =
      | { type: "updated"; batch: PendingQuestionBatch }
      | { type: "missing" }
      | { type: "conflict"; batch: PendingQuestionBatch };

    const getQuestionBatch = (requestId: string) =>
      Ref.get(batchesRef).pipe(Effect.map((batches) => batches.get(requestId) ?? null));

    const updateQuestionBatch = (
      requestId: string,
      update: (batch: PendingQuestionBatch) => PendingQuestionBatch | null,
    ) =>
      Ref.modify(
        batchesRef,
        (current): readonly [PendingQuestionBatch | null, Map<string, PendingQuestionBatch>] => {
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

    const tryPersistQuestionBatch = (
      requestId: string,
      expectedVersion: number,
      actorId: string,
      update: (batch: PendingQuestionBatch) => PendingQuestionBatch,
    ) =>
      Ref.modify(
        batchesRef,
        (current): readonly [PersistQuestionBatchResult, Map<string, PendingQuestionBatch>] => {
          const existing = current.get(requestId);
          if (!existing) {
            return [{ type: "missing" }, current];
          }
          if (existing.version !== expectedVersion) {
            return [{ type: "conflict", batch: existing }, current];
          }

          const updated = update(existing);
          const nextBatch =
            updated === existing
              ? existing
              : {
                  ...updated,
                  version: existing.version + 1,
                  lastModifiedBy: actorId,
                };
          const batches = new Map(current);
          batches.set(requestId, nextBatch);
          return [{ type: "updated", batch: nextBatch }, batches];
        },
      );

    const removeQuestionBatch = (requestId: string) =>
      Ref.modify(
        batchesRef,
        (current): readonly [PendingQuestionBatch | null, Map<string, PendingQuestionBatch>] => {
          const existing = current.get(requestId) ?? null;
          if (!existing) {
            return [null, current];
          }

          const batches = new Map(current);
          batches.delete(requestId);
          return [existing, batches];
        },
      );

    const takeDetachedFinalizedBatch = (requestId: string) =>
      Ref.modify(
        detachedFinalizedBatchesRef,
        (current): readonly [PendingQuestionBatch | null, Map<string, PendingQuestionBatch>] => {
          const existing = current.get(requestId) ?? null;
          if (!existing) {
            return [null, current];
          }

          const batches = new Map(current);
          batches.delete(requestId);
          return [existing, batches];
        },
      );

    const rememberDetachedFinalizedBatch = (batch: PendingQuestionBatch) => {
      if (batch.message) {
        return Effect.void;
      }

      return Ref.update(detachedFinalizedBatchesRef, (current) => {
        const batches = new Map(current);
        batches.set(batch.request.id, batch);
        return batches;
      });
    };

    const hasPendingQuestionsForSession = (sessionId: string) =>
      Ref.get(batchesRef).pipe(
        Effect.map((batches) =>
          [...batches.values()].some(
            (batch) =>
              batch.session.opencode.sessionId === sessionId &&
              (batch.status === "active" || batch.status === "submitting"),
          ),
        ),
      );

    const syncTypingForSession = (sessionId: string) =>
      deps.getSessionContext(sessionId).pipe(
        Effect.flatMap((context) => {
          const activeRun = context?.activeRun ?? null;
          if (!activeRun) {
            return Effect.void;
          }

          return hasPendingQuestionsForSession(sessionId).pipe(
            Effect.flatMap((hasPendingQuestions) => {
              if (hasPendingQuestions) {
                return Effect.promise(() => activeRun.typing.pause()).pipe(
                  Effect.timeoutOption("1 second"),
                  Effect.flatMap((result) =>
                    result._tag === "Some"
                      ? Effect.void
                      : deps.logger.warn(
                          "typing pause timed out while question prompt was active",
                          {
                            channelId: activeRun.originMessage.channelId,
                            sessionId,
                          },
                        ),
                  ),
                );
              }

              return Effect.sync(() => {
                activeRun.typing.resume();
              });
            }),
          );
        }),
      );

    const editQuestionMessage = (batch: PendingQuestionBatch) => {
      const message = batch.message;
      if (!message) {
        return Effect.void;
      }

      return Effect.promise(() =>
        message.edit(createQuestionMessageEdit(questionBatchView(batch))),
      ).pipe(Effect.asVoid);
    };

    const attachQuestionMessage = (requestId: string, message: Message) =>
      Effect.gen(function* () {
        const attached = yield* updateQuestionBatch(requestId, (current) => ({
          ...current,
          message,
        }));
        if (attached) {
          return {
            type: "attached" as const,
            batch: attached,
          };
        }

        const finalized = yield* takeDetachedFinalizedBatch(requestId);
        if (finalized) {
          return {
            type: "finalized" as const,
            batch: {
              ...finalized,
              message,
            },
          };
        }

        return { type: "missing" as const };
      });

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

    const replyToQuestionConflict = (interaction: Interaction, batch: PendingQuestionBatch) =>
      replyToQuestionInteraction(
        interaction,
        batch.lastModifiedBy && batch.lastModifiedBy !== interaction.user.id
          ? "Another user updated this question prompt before your action was applied. Review the latest card and try again."
          : "This question prompt changed before your action was applied. Review the latest card and try again.",
      );

    const handleQuestionAsked = (
      session: ChannelSession,
      activeRun: ActiveRun,
      request: QuestionRequest,
    ) =>
      Effect.gen(function* () {
        if (yield* Ref.get(shutdownStartedRef)) {
          return;
        }

        if (activeRun.interruptRequested) {
          activeRun.interruptRequested = false;
          activeRun.interruptSource = null;
          yield* deps.logger.info("question prompt superseded interrupt request", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            requestId: request.id,
          });
        }

        const batch = yield* Ref.modify(
          batchesRef,
          (current): readonly [PendingQuestionBatch | null, Map<string, PendingQuestionBatch>] => {
            if (current.has(request.id)) {
              return [null, current];
            }

            const created: PendingQuestionBatch = {
              request,
              session,
              version: 0,
              lastModifiedBy: null,
              message: null,
              page: 0,
              optionPages: request.questions.map(() => 0),
              drafts: questionDrafts(request),
              status: "active",
            };
            const batches = new Map(current);
            batches.set(request.id, created);
            return [created, batches];
          },
        );
        if (!batch) {
          return;
        }

        const replyTargetMessage = currentPromptReplyTargetMessage(activeRun);
        const questionMessage = yield* Effect.tryPromise({
          try: () =>
            replyTargetMessage.reply({
              ...createQuestionMessageCreate(questionBatchView(batch)),
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
          const attached = yield* attachQuestionMessage(request.id, questionMessage.success);
          if (attached.type === "attached") {
            yield* syncTypingForSession(session.opencode.sessionId);
            return;
          }

          if (attached.type === "finalized") {
            yield* editQuestionMessage(attached.batch).pipe(
              Effect.catch((error) =>
                deps.logger.warn("failed to edit finalized question batch after late post", {
                  channelId: session.channelId,
                  sessionId: session.opencode.sessionId,
                  requestId: request.id,
                  error: deps.formatError(error),
                }),
              ),
            );
            return;
          }

          yield* deps.logger.warn("question batch was missing after successful post", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            requestId: request.id,
          });
          return;
        }

        const removed = yield* removeQuestionBatch(request.id);
        if (!removed && (yield* takeDetachedFinalizedBatch(request.id))) {
          return;
        }
        if (!removed) {
          yield* deps.logger.warn("question batch was missing after failed post", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            requestId: request.id,
          });
          return;
        }

        const questionUiFailure = deps.formatError(questionMessage.failure);
        activeRun.questionOutcome = questionUiFailureOutcome(questionUiFailure);

        yield* deps.logger.error("failed to post question batch", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          requestId: request.id,
          error: deps.formatError(questionMessage.failure),
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

          yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore);
          const failureReply = yield* deps
            .sendQuestionUiFailure(replyTargetMessage, questionUiFailure)
            .pipe(Effect.result);
          if (failureReply._tag === "Success") {
            activeRun.questionOutcome = questionUiFailureOutcome(questionUiFailure, true);
          } else {
            yield* deps.logger.error("failed to send question UI failure message", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              requestId: request.id,
              error: deps.formatError(failureReply.failure),
            });
          }
          return;
        }

        yield* syncTypingForSession(session.opencode.sessionId);
      });

    const completeShutdownRejectedRequest = (requestId: string) =>
      Ref.modify(
        shutdownRejectedRequestIdsRef,
        (current): readonly [boolean, Set<string>] => {
          if (!current.has(requestId)) {
            return [false, current];
          }

          const next = new Set(current);
          next.delete(requestId);
          return [true, next];
        },
      );

    const finalizeQuestionBatch = (
      requestId: string,
      status: "answered" | "rejected",
      resolvedAnswers?: ReadonlyArray<QuestionAnswer>,
    ) =>
      Effect.gen(function* () {
        const renderExpired = status === "rejected" && (yield* completeShutdownRejectedRequest(requestId));
        const batch = yield* updateQuestionBatch(requestId, (current) =>
          renderExpired
            ? terminateQuestionBatch(current, "expired")
            : setQuestionBatchStatus(current, status, resolvedAnswers),
        );
        if (!batch) {
          return;
        }

        yield* editQuestionMessage(batch).pipe(
          Effect.catch((error) =>
            deps.logger.warn("failed to edit finalized question batch", {
              channelId: batch.session.channelId,
              sessionId: batch.session.opencode.sessionId,
              requestId,
              error: deps.formatError(error),
            }),
          ),
        );
        yield* rememberDetachedFinalizedBatch(batch);
        yield* removeQuestionBatch(requestId);
        yield* syncTypingForSession(batch.session.opencode.sessionId);
      });

    const updateInteraction = (interaction: Interaction, batch: PendingQuestionBatch) => {
      if (!interaction.isButton()) {
        return Effect.void;
      }
      return Effect.promise(() =>
        interaction.update(createQuestionMessageEdit(questionBatchView(batch))),
      );
    };

    const questionSubmissionDeps = {
      tryPersistBatch: tryPersistQuestionBatch,
      restoreBatch: updateQuestionBatch,
      updateInteraction,
      editBatch: editQuestionMessage,
      finalizeBatch: finalizeQuestionBatch,
      replyExpired: (interaction: Interaction) =>
        replyToQuestionInteraction(interaction, "This question prompt has expired."),
      replyConflict: replyToQuestionConflict,
      followUpFailure: (interaction: Interaction, message: string) => {
        if (!interaction.isButton()) {
          return Effect.void;
        }
        return Effect.promise(() => interaction.followUp(questionInteractionReply(message)));
      },
      submitToOpencode: deps.replyToQuestion,
      rejectInOpencode: deps.rejectQuestion,
      formatError: deps.formatError,
    } as const;

    const currentQuestionDraft = (batch: PendingQuestionBatch, questionIndex: number) =>
      batch.drafts[questionIndex] ?? clearQuestionDraft();

    const applyQuestionUpdate = (
      interaction: Interaction,
      requestId: string,
      expectedVersion: number,
      update: (batch: PendingQuestionBatch) => PendingQuestionBatch,
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

    const handleInteraction = (interaction: Interaction): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        if (
          !interaction.isButton() &&
          !interaction.isStringSelectMenu() &&
          !interaction.isModalSubmit()
        ) {
          return;
        }

        const action = parseQuestionActionId(interaction.customId);
        if (!action) {
          return;
        }

        if (yield* Ref.get(shutdownStartedRef)) {
          yield* replyToQuestionInteraction(interaction, "This question prompt has expired.");
          return;
        }

        const batch = yield* getQuestionBatch(action.requestID);
        if (!batch) {
          yield* replyToQuestionInteraction(interaction, "This question prompt has expired.");
          return;
        }

        if (
          (interaction.isButton() || interaction.isStringSelectMenu()) &&
          batch.message &&
          interaction.message.id !== batch.message.id
        ) {
          yield* replyToQuestionInteraction(interaction, "This question prompt has been replaced.");
          return;
        }

        if (batch.status !== "active") {
          yield* replyToQuestionInteraction(
            interaction,
            "This question prompt is already being finalized.",
          );
          return;
        }

        if (batch.version !== action.version) {
          yield* replyToQuestionConflict(interaction, batch);
          return;
        }

        switch (action.kind) {
          case "question-prev":
            yield* applyQuestionUpdate(
              interaction,
              action.requestID,
              action.version,
              (current) => ({
                ...current,
                page: Math.max(0, current.page - 1),
              }),
            );
            return;
          case "question-next":
            yield* applyQuestionUpdate(
              interaction,
              action.requestID,
              action.version,
              (current) => ({
                ...current,
                page: Math.min(current.request.questions.length - 1, current.page + 1),
              }),
            );
            return;
          case "option-prev":
            yield* applyQuestionUpdate(interaction, action.requestID, action.version, (current) => {
              const optionPages = [...current.optionPages];
              optionPages[action.questionIndex] = Math.max(
                0,
                (optionPages[action.questionIndex] ?? 0) - 1,
              );
              return {
                ...current,
                page: action.questionIndex,
                optionPages,
              };
            });
            return;
          case "option-next":
            yield* applyQuestionUpdate(interaction, action.requestID, action.version, (current) => {
              const question = current.request.questions[action.questionIndex];
              if (!question) {
                return current;
              }
              const maxOptionPage = Math.max(0, questionOptionPageCount(question) - 1);
              const optionPages = [...current.optionPages];
              optionPages[action.questionIndex] = Math.min(
                maxOptionPage,
                (optionPages[action.questionIndex] ?? 0) + 1,
              );
              return {
                ...current,
                page: action.questionIndex,
                optionPages,
              };
            });
            return;
          case "clear":
            yield* applyQuestionUpdate(interaction, action.requestID, action.version, (current) => {
              const drafts = [...current.drafts];
              drafts[action.questionIndex] = clearQuestionDraft();
              return {
                ...current,
                page: action.questionIndex,
                drafts,
              };
            });
            return;
          case "select":
            if (!interaction.isStringSelectMenu()) {
              return;
            }

            yield* applyQuestionUpdate(interaction, action.requestID, action.version, (current) => {
              const question = current.request.questions[action.questionIndex];
              if (!question) {
                return current;
              }

              const page = current.optionPages[action.questionIndex] ?? 0;
              const visibleOptions = question.options
                .slice(
                  page * QUESTION_OPTIONS_PER_PAGE,
                  page * QUESTION_OPTIONS_PER_PAGE + QUESTION_OPTIONS_PER_PAGE,
                )
                .map((option) => option.label);
              const drafts = [...current.drafts];
              drafts[action.questionIndex] = setQuestionOptionSelection({
                question,
                draft: currentQuestionDraft(current, action.questionIndex),
                visibleOptions,
                selectedOptions: interaction.values,
              });
              return {
                ...current,
                page: action.questionIndex,
                drafts,
              };
            });
            return;
          case "custom":
            if (!interaction.isButton()) {
              return;
            }

            {
              const question = batch.request.questions[action.questionIndex];
              if (!question || question.custom === false) {
                yield* replyToQuestionInteraction(
                  interaction,
                  "This question does not allow a custom answer.",
                );
                return;
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
              return;
            }
          case "modal":
            if (!interaction.isModalSubmit()) {
              return;
            }

            {
              const question = batch.request.questions[action.questionIndex];
              if (!question || question.custom === false) {
                yield* replyToQuestionInteraction(
                  interaction,
                  "This question does not allow a custom answer.",
                );
                return;
              }

              const customAnswer = readQuestionModalValue(interaction);
              if (!customAnswer) {
                yield* Effect.promise(() =>
                  interaction.reply(questionInteractionReply("Custom answer cannot be empty.")),
                ).pipe(Effect.ignore);
                return;
              }

              const updated = yield* tryPersistQuestionBatch(
                action.requestID,
                action.version,
                interaction.user.id,
                (current) => {
                  const drafts = [...current.drafts];
                  drafts[action.questionIndex] = setQuestionCustomAnswer(
                    question,
                    currentQuestionDraft(current, action.questionIndex),
                    customAnswer,
                  );
                  return {
                    ...current,
                    page: action.questionIndex,
                    drafts,
                  };
                },
              );
              if (updated.type === "missing") {
                yield* replyToQuestionInteraction(interaction, "This question prompt has expired.");
                return;
              }
              if (updated.type === "conflict") {
                yield* replyToQuestionConflict(interaction, updated.batch);
                return;
              }

              yield* editQuestionMessage(updated.batch).pipe(
                Effect.catch((error) =>
                  deps.logger.warn("failed to edit question batch after modal submit", {
                    channelId: updated.batch.session.channelId,
                    sessionId: updated.batch.session.opencode.sessionId,
                    requestId: updated.batch.request.id,
                    error: deps.formatError(error),
                  }),
                ),
              );
              yield* Effect.promise(() => interaction.deferUpdate()).pipe(Effect.ignore);
              return;
            }
          case "submit":
            if (!interaction.isButton()) {
              return;
            }

            yield* submitQuestionBatch(questionSubmissionDeps)({
              interaction,
              requestId: action.requestID,
              expectedVersion: action.version,
              actorId: interaction.user.id,
              answers: buildQuestionAnswers(batch.request, batch.drafts),
            });
            return;
          case "reject":
            if (!interaction.isButton()) {
              return;
            }

            yield* rejectQuestionBatch(questionSubmissionDeps)({
              interaction,
              requestId: action.requestID,
              expectedVersion: action.version,
              actorId: interaction.user.id,
            });
            return;
        }
      });

    const terminateMatchingBatches = (predicate: (batch: PendingQuestionBatch) => boolean) =>
      Effect.gen(function* () {
        const { terminated, sessionIds } = yield* Ref.modify(
          batchesRef,
          (
            current,
          ): readonly [
            { terminated: PendingQuestionBatch[]; sessionIds: string[] },
            Map<string, PendingQuestionBatch>,
          ] => {
            const stale = [...current.values()].filter(
              (batch) =>
                predicate(batch) && (batch.status === "active" || batch.status === "submitting"),
            );
            if (stale.length === 0) {
              return [{ terminated: [], sessionIds: [] }, current];
            }

            const batches = new Map(current);
            const terminated = stale.map((batch) => terminateQuestionBatch(batch, "expired"));
            for (const batch of stale) {
              batches.delete(batch.request.id);
            }

            return [
              {
                terminated,
                sessionIds: [
                  ...new Set(terminated.map((batch) => batch.session.opencode.sessionId)),
                ],
              },
              batches,
            ];
          },
        );

        yield* Effect.forEach(terminated, rememberDetachedFinalizedBatch, {
          concurrency: "unbounded",
          discard: true,
        });

        yield* Effect.forEach(
          terminated,
          (batch) =>
            batch.message
              ? editQuestionMessage(batch).pipe(
                  Effect.catch((error) =>
                    deps.logger.warn("failed to terminate question batch message", {
                      channelId: batch.session.channelId,
                      sessionId: batch.session.opencode.sessionId,
                      requestId: batch.request.id,
                      error: deps.formatError(error),
                    }),
                  ),
                )
              : Effect.void,
          { concurrency: "unbounded" },
        ).pipe(Effect.asVoid);

        yield* Effect.forEach(
          sessionIds,
          (sessionId) =>
            syncTypingForSession(sessionId).pipe(
              Effect.catch((error) =>
                deps.logger.warn("failed to sync typing after question termination", {
                  sessionId,
                  error: deps.formatError(error),
                }),
              ),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.asVoid);
      });

    const terminateForSession = (sessionId: string) =>
      terminateMatchingBatches((batch) => batch.session.opencode.sessionId === sessionId);

    const beginShutdown = () =>
      Ref.modify(shutdownStartedRef, (started): readonly [Effect.Effect<void>, boolean] =>
        started ? [Effect.void, true] : [Effect.void, true],
      ).pipe(Effect.flatten);

    const shutdown = () =>
      beginShutdown().pipe(Effect.andThen(terminateMatchingBatches(() => true)));

    return {
      handleEvent: (event) => {
        switch (event.type) {
          case "asked":
            return deps.getSessionContext(event.sessionId).pipe(
              Effect.flatMap((context) => {
                if (!context?.activeRun) {
                  return Effect.void;
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
      hasPendingQuestionsForSession,
      beginShutdown,
      getPendingRequestIdsForSession: (sessionId) =>
        Ref.get(batchesRef).pipe(
          Effect.map((batches) =>
            [...batches.values()]
              .filter(
                (batch) =>
                  batch.session.opencode.sessionId === sessionId &&
                  (batch.status === "active" || batch.status === "submitting"),
              )
              .map((batch) => batch.request.id),
          ),
        ),
      markShutdownRejectedRequests: (requestIds) =>
        requestIds.length === 0
          ? Effect.void
          : Ref.update(shutdownRejectedRequestIdsRef, (current) => {
              const next = new Set(current);
              for (const requestId of requestIds) {
                next.add(requestId);
              }
              return next;
            }),
      terminateForSession,
      shutdown,
    } satisfies QuestionCoordinator;
  });
