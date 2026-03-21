import type { Event, QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";
import { Data, Effect, Ref } from "effect";
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
import { getEventByType } from "@/opencode/events.ts";
import type { OpencodeServiceShape } from "@/opencode/service.ts";
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
import type { QuestionWorkflowSignal } from "@/sessions/question/question-run-state.ts";
import type { SessionContext } from "@/sessions/session-runtime.ts";
import {
  currentPromptReplyTargetMessage,
  questionUiFailureOutcome,
  type ActiveRun,
  type ChannelSession,
} from "@/sessions/session.ts";
import { formatError } from "@/util/errors.ts";
import type { LoggerShape } from "@/util/logging.ts";

export type QuestionWorkflowEvent =
  | { type: "asked"; sessionId: string; request: QuestionRequest }
  | {
      type: "replied";
      sessionId: string;
      requestId: string;
      answers: ReadonlyArray<QuestionAnswer>;
    }
  | { type: "rejected"; sessionId: string; requestId: string };

export type RoutedQuestionSignals = {
  sessionId: string;
  signals: ReadonlyArray<QuestionWorkflowSignal>;
};

export type QuestionRuntime = {
  handleEvent: (
    event: QuestionWorkflowEvent,
  ) => Effect.Effect<RoutedQuestionSignals | null, unknown>;
  routeInteraction: (
    interaction: Interaction,
  ) => Effect.Effect<RoutedQuestionSignals | null, unknown>;
  hasPendingQuestions: (sessionId: string) => Effect.Effect<boolean>;
  hasPendingQuestionsAnywhere: () => Effect.Effect<boolean>;
  terminateSession: (
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<QuestionWorkflowSignal>, unknown>;
  shutdownSession: (sessionId: string) => Effect.Effect<void, unknown>;
  cleanupShutdownQuestions: () => Effect.Effect<void, unknown>;
};

type QuestionRuntimeDeps = {
  getSessionContext: (sessionId: string) => Effect.Effect<SessionContext | null>;
  replyToQuestion: OpencodeServiceShape["replyToQuestion"];
  rejectQuestion: OpencodeServiceShape["rejectQuestion"];
  sendQuestionUiFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>;
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

type QuestionSessionState = {
  stopped: boolean;
  batches: Map<string, QuestionWorkflowBatch>;
};

type QuestionRuntimeState = {
  sessions: Map<string, QuestionSessionState>;
  requestRoutes: Map<string, string>;
};

type PersistQuestionBatchResult =
  | { type: "updated"; batch: QuestionWorkflowBatch }
  | { type: "missing" }
  | { type: "conflict"; batch: QuestionWorkflowBatch };

type RoutedQuestionBatch = { sessionId: string; batch: QuestionWorkflowBatch | null } | null;

type RemoteQuestionAction = {
  sessionId: string;
  interaction: Interaction;
  requestId: string;
  expectedVersion: number;
  invoke: (session: ChannelSession["opencode"], requestId: string) => Effect.Effect<void, unknown>;
  followUpFailure: (error: unknown) => string;
  onSuccess: (batch: QuestionWorkflowBatch) => Effect.Effect<ReadonlyArray<QuestionWorkflowSignal>>;
};

const SHUTDOWN_QUESTION_RPC_TIMEOUT = "1 second";

class QuestionRuntimeError extends Data.TaggedError("QuestionRuntimeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const questionRuntimeError = (message: string, cause?: unknown) =>
  new QuestionRuntimeError({ message, cause });

const noSignals: ReadonlyArray<QuestionWorkflowSignal> = [];
const signal = <A extends QuestionWorkflowSignal>(value: A): ReadonlyArray<A> => [value];
const appendSignals = (
  left: ReadonlyArray<QuestionWorkflowSignal>,
  right: ReadonlyArray<QuestionWorkflowSignal>,
): ReadonlyArray<QuestionWorkflowSignal> => (left.length === 0 ? right : [...left, ...right]);
const routedNoSignals = (sessionId: string): RoutedQuestionSignals => ({
  sessionId,
  signals: noSignals,
});

const emptyQuestionSessionState = (): QuestionSessionState => ({
  stopped: false,
  batches: new Map(),
});

const writeSessionState = (
  state: QuestionRuntimeState,
  sessionId: string,
  session: QuestionSessionState,
): QuestionRuntimeState => {
  const sessions = new Map(state.sessions);
  if (session.stopped || session.batches.size > 0) {
    sessions.set(sessionId, session);
  } else {
    sessions.delete(sessionId);
  }
  return {
    ...state,
    sessions,
  };
};

const writeSessionBatchesState = (
  state: QuestionRuntimeState,
  sessionId: string,
  session: QuestionSessionState,
  batches: QuestionSessionState["batches"],
): QuestionRuntimeState => writeSessionState(state, sessionId, { ...session, batches });

const dropRequestRoute = (state: QuestionRuntimeState, requestId: string): QuestionRuntimeState => {
  if (!state.requestRoutes.has(requestId)) {
    return state;
  }

  const requestRoutes = new Map(state.requestRoutes);
  requestRoutes.delete(requestId);
  return {
    ...state,
    requestRoutes,
  };
};

export const routeQuestionEvent = (
  event: Event,
  deps: {
    sessionId: string;
    handleQuestionEvent: (event: QuestionWorkflowEvent) => Effect.Effect<void, unknown>;
  },
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const questionAsked = getEventByType(event, "question.asked")?.properties ?? null;
    const questionReplied = getEventByType(event, "question.replied")?.properties ?? null;
    const questionRejected = getEventByType(event, "question.rejected")?.properties ?? null;

    if (questionAsked) {
      yield* deps.handleQuestionEvent({
        type: "asked",
        sessionId: deps.sessionId,
        request: questionAsked,
      });
    }
    if (questionReplied) {
      yield* deps.handleQuestionEvent({
        type: "replied",
        sessionId: deps.sessionId,
        requestId: questionReplied.requestID,
        answers: questionReplied.answers,
      });
    }
    if (questionRejected) {
      yield* deps.handleQuestionEvent({
        type: "rejected",
        sessionId: deps.sessionId,
        requestId: questionRejected.requestID,
      });
    }
  });

export const makeQuestionRuntime = (deps: QuestionRuntimeDeps): Effect.Effect<QuestionRuntime> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<QuestionRuntimeState>({
      sessions: new Map(),
      requestRoutes: new Map(),
    });

    const readState = () => Ref.get(stateRef);
    const getSessionState = (sessionId: string) =>
      readState().pipe(Effect.map((state) => state.sessions.get(sessionId) ?? null));
    const getQuestionBatch = (requestId: string) =>
      readState().pipe(
        Effect.map((state): RoutedQuestionBatch => {
          const sessionId = state.requestRoutes.get(requestId);
          if (!sessionId) {
            return null;
          }
          return {
            sessionId,
            batch: state.sessions.get(sessionId)?.batches.get(requestId) ?? null,
          };
        }),
      );

    const deleteQuestionBatch = (sessionId: string, requestId: string) =>
      Ref.modify(
        stateRef,
        (current): readonly [QuestionWorkflowBatch | null, QuestionRuntimeState] => {
          const session = current.sessions.get(sessionId);
          const batch = session?.batches.get(requestId) ?? null;
          if (!batch || !session) {
            return [null, current];
          }

          const batches = new Map(session.batches);
          batches.delete(requestId);
          return [
            batch,
            writeSessionBatchesState(
              dropRequestRoute(current, requestId),
              sessionId,
              session,
              batches,
            ),
          ];
        },
      );

    const updateQuestionBatch = (
      sessionId: string,
      requestId: string,
      update: (batch: QuestionWorkflowBatch) => QuestionWorkflowBatch | null,
    ) =>
      Ref.modify(
        stateRef,
        (current): readonly [QuestionWorkflowBatch | null, QuestionRuntimeState] => {
          const session = current.sessions.get(sessionId);
          const existing = session?.batches.get(requestId);
          if (!existing || !session) {
            return [null, current];
          }

          const nextBatch = update(existing);
          const batches = new Map(session.batches);
          let nextState = current;
          if (nextBatch) {
            batches.set(requestId, nextBatch);
          } else {
            batches.delete(requestId);
            nextState = dropRequestRoute(nextState, requestId);
          }

          return [nextBatch, writeSessionBatchesState(nextState, sessionId, session, batches)];
        },
      );

    const tryPersistQuestionBatch = (
      sessionId: string,
      requestId: string,
      expectedVersion: number,
      actorId: string,
      update: (batch: QuestionWorkflowBatch) => QuestionWorkflowBatch,
    ) =>
      Ref.modify(
        stateRef,
        (current): readonly [PersistQuestionBatchResult, QuestionRuntimeState] => {
          const session = current.sessions.get(sessionId);
          const existing = session?.batches.get(requestId);
          if (!existing || !session) {
            return [{ type: "missing" }, current];
          }
          if (existing.domain.version !== expectedVersion) {
            return [{ type: "conflict", batch: existing }, current];
          }

          const batches = new Map(session.batches);
          const batch = persistQuestionBatchUpdate(existing, actorId, update);
          batches.set(requestId, batch);
          return [
            { type: "updated", batch },
            writeSessionBatchesState(current, sessionId, session, batches),
          ];
        },
      );

    const expirePendingBatches = (sessionId: string, includeRequestIds = false) =>
      Ref.modify(
        stateRef,
        (
          current,
        ): readonly [
          { terminated: QuestionWorkflowBatch[]; requestIds: string[] },
          QuestionRuntimeState,
        ] => {
          const session = current.sessions.get(sessionId);
          if (!session) {
            return [{ terminated: [], requestIds: [] }, current];
          }

          const batches = new Map(session.batches);
          const requestRoutes = new Map(current.requestRoutes);
          const terminated: QuestionWorkflowBatch[] = [];
          const requestIds: string[] = [];

          for (const [requestId, batch] of session.batches) {
            if (!isPendingQuestionBatch(batch)) {
              continue;
            }
            terminated.push(terminateQuestionBatch(batch));
            if (includeRequestIds) {
              requestIds.push(requestId);
            }
            batches.delete(requestId);
            requestRoutes.delete(requestId);
          }

          return [
            { terminated, requestIds },
            writeSessionBatchesState(
              {
                ...current,
                requestRoutes,
              },
              sessionId,
              session,
              batches,
            ),
          ];
        },
      );

    const markSessionStopped = (sessionId: string) =>
      Ref.update(stateRef, (current) =>
        writeSessionState(current, sessionId, {
          batches: new Map(
            (current.sessions.get(sessionId) ?? emptyQuestionSessionState()).batches,
          ),
          stopped: true,
        }),
      );

    const hasPendingQuestions = (sessionId: string) =>
      getSessionState(sessionId).pipe(
        Effect.map(
          (session) => !!session && [...session.batches.values()].some(isPendingQuestionBatch),
        ),
      );

    const hasPendingQuestionsAnywhere = () =>
      readState().pipe(
        Effect.map((state) =>
          [...state.sessions.values()].some((session) =>
            [...session.batches.values()].some(isPendingQuestionBatch),
          ),
        ),
      );

    const editQuestionMessage = (batch: QuestionWorkflowBatch) => {
      const attachment = batch.runtime.attachment;
      return attachment._tag !== "attached"
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

    const replyToQuestionConflict = (interaction: Interaction, batch: QuestionWorkflowBatch) =>
      replyToQuestionInteraction(
        interaction,
        batch.runtime.lastModifiedBy && batch.runtime.lastModifiedBy !== interaction.user.id
          ? "Another user updated this question prompt before your action was applied. Review the latest card and try again."
          : "This question prompt changed before your action was applied. Review the latest card and try again.",
      );

    const editQuestionMessageLogged = (batch: QuestionWorkflowBatch, failureMessage: string) =>
      editQuestionMessage(batch).pipe(
        Effect.catch((error) =>
          deps.logger.warn(failureMessage, {
            channelId: batch.runtime.channelId,
            requestId: batch.domain.request.id,
            error: deps.formatError(error),
          }),
        ),
      );

    const finalizeBatchIfAttached = (batch: QuestionWorkflowBatch) =>
      !isTerminalQuestionBatch(batch) || batch.runtime.attachment._tag !== "attached"
        ? Effect.void
        : editQuestionMessageLogged(batch, "failed to edit finalized question batch");

    const attachPostedQuestionMessage = (sessionId: string, requestId: string, message: Message) =>
      updateQuestionBatch(sessionId, requestId, (current) =>
        attachQuestionMessage(
          current.domain.lifecycle === "posting" ? activateQuestionBatch(current) : current,
          message,
        ),
      );

    const finalizeQuestionBatch = (
      sessionId: string,
      requestId: string,
      lifecycle: "answered" | "rejected",
      resolvedAnswers?: ReadonlyArray<QuestionAnswer>,
    ) =>
      Effect.gen(function* () {
        const batch = yield* updateQuestionBatch(sessionId, requestId, (current) =>
          setQuestionBatchStatus(current, lifecycle, resolvedAnswers),
        );
        if (!batch) {
          return noSignals;
        }

        yield* finalizeBatchIfAttached(batch);
        yield* deleteQuestionBatch(sessionId, requestId).pipe(Effect.asVoid);
        return noSignals;
      });

    const updateInteraction = (interaction: Interaction, batch: QuestionWorkflowBatch) =>
      !interaction.isButton()
        ? Effect.void
        : Effect.promise(() =>
            interaction.update(createQuestionMessageEdit(questionBatchView(batch))),
          );

    const routeQuestionUpdate = <A extends { requestID: string; version: number }>(
      sessionId: string,
      interaction: Interaction,
      action: A,
      update: (batch: QuestionWorkflowBatch) => QuestionWorkflowBatch,
    ) =>
      applyQuestionUpdate(sessionId, interaction, action.requestID, action.version, update).pipe(
        Effect.as(routedNoSignals(sessionId)),
      );

    const setQuestionDraft = (
      batch: QuestionWorkflowBatch,
      questionIndex: number,
      draft: QuestionWorkflowBatch["domain"]["drafts"][number],
    ): QuestionWorkflowBatch => {
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
      batch: QuestionWorkflowBatch,
      questionIndex: number,
    ): Effect.Effect<QuestionRequest["questions"][number] | null> => {
      const question = batch.domain.request.questions[questionIndex];
      return !question || question.custom === false
        ? replyToQuestionInteraction(
            interaction,
            "This question does not allow a custom answer.",
          ).pipe(Effect.as(null))
        : Effect.succeed(question);
    };

    const persistQuestionBatchOrReply = (input: {
      sessionId: string;
      interaction: Interaction;
      requestId: string;
      expectedVersion: number;
      update: (batch: QuestionWorkflowBatch) => QuestionWorkflowBatch;
      missingMessage: string;
    }) =>
      tryPersistQuestionBatch(
        input.sessionId,
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

    const finalizeRemoteQuestionBatch = (input: RemoteQuestionAction) =>
      Effect.gen(function* () {
        const pending = yield* persistQuestionBatchOrReply({
          sessionId: input.sessionId,
          interaction: input.interaction,
          requestId: input.requestId,
          expectedVersion: input.expectedVersion,
          update: (current) => setQuestionBatchStatus(current, "submitting"),
          missingMessage: "This question prompt has expired.",
        });
        if (!pending) {
          return noSignals;
        }

        const session = yield* deps
          .getSessionContext(input.sessionId)
          .pipe(Effect.map((context) => context?.session ?? null));
        if (!session) {
          const expired = yield* updateQuestionBatch(input.sessionId, input.requestId, (current) =>
            terminateQuestionBatch(current),
          );
          if (!expired) {
            yield* replyToQuestionInteraction(
              input.interaction,
              "This question prompt has expired.",
            );
            return noSignals;
          }
          yield* updateInteraction(input.interaction, expired);
          yield* deleteQuestionBatch(input.sessionId, input.requestId).pipe(Effect.asVoid);
          return noSignals;
        }

        yield* updateInteraction(input.interaction, pending);

        return yield* input.invoke(session.opencode, pending.domain.request.id).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                const restored = yield* updateQuestionBatch(
                  input.sessionId,
                  input.requestId,
                  (current) => setQuestionBatchStatus(current, "active"),
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

    const currentQuestionDraft = (batch: QuestionWorkflowBatch, questionIndex: number) =>
      batch.domain.drafts[questionIndex] ?? clearQuestionDraft();

    const applyQuestionUpdate = (
      sessionId: string,
      interaction: Interaction,
      requestId: string,
      expectedVersion: number,
      update: (batch: QuestionWorkflowBatch) => QuestionWorkflowBatch,
    ) =>
      Effect.gen(function* () {
        if (!interaction.isButton() && !interaction.isStringSelectMenu()) {
          return;
        }

        const persisted = yield* persistQuestionBatchOrReply({
          sessionId,
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

    const handleQuestionAsked = (
      sessionId: string,
      session: ChannelSession,
      activeRun: ActiveRun,
      request: QuestionRequest,
    ) =>
      Effect.gen(function* () {
        const batch = yield* Ref.modify(
          stateRef,
          (current): readonly [QuestionWorkflowBatch | null, QuestionRuntimeState] => {
            const sessionState = current.sessions.get(sessionId) ?? emptyQuestionSessionState();
            if (sessionState.stopped || sessionState.batches.has(request.id)) {
              return [null, current];
            }

            const created = createQuestionWorkflowBatch({
              request,
              channelId: session.channelId,
              replyTargetMessage: currentPromptReplyTargetMessage(activeRun),
              drafts: questionDrafts(request),
            });
            const batches = new Map(sessionState.batches);
            batches.set(request.id, created);
            const requestRoutes = new Map(current.requestRoutes);
            requestRoutes.set(request.id, sessionId);
            return [
              created,
              writeSessionState(
                {
                  ...current,
                  requestRoutes,
                },
                sessionId,
                {
                  ...sessionState,
                  batches,
                },
              ),
            ];
          },
        );
        if (!batch) {
          return noSignals;
        }

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
          catch: (cause) => questionRuntimeError(formatError(cause), cause),
        }).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            onTimeout: () =>
              Effect.fail(questionRuntimeError("Timed out sending question batch to Discord")),
          }),
          Effect.result,
        );

        if (questionMessage._tag === "Success") {
          yield* attachPostedQuestionMessage(sessionId, request.id, questionMessage.success);
          return signals;
        }

        yield* deleteQuestionBatch(sessionId, request.id);
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
          return null;
        }

        const action = parseQuestionActionId(interaction.customId);
        if (!action) {
          return null;
        }

        const routed = yield* getQuestionBatch(action.requestID);
        if (!routed || !routed.batch) {
          if (routed) {
            yield* Ref.update(stateRef, (state) => dropRequestRoute(state, action.requestID));
          }
          yield* replyToQuestionInteraction(interaction, "This question prompt has expired.");
          return null;
        }

        const { batch, sessionId } = routed;
        if (
          (interaction.isButton() || interaction.isStringSelectMenu()) &&
          batch.runtime.attachment._tag === "attached" &&
          interaction.message.id !== batch.runtime.attachment.message.id
        ) {
          yield* replyToQuestionInteraction(interaction, "This question prompt has been replaced.");
          return null;
        }

        if (batch.domain.lifecycle !== "active") {
          yield* replyToQuestionInteraction(
            interaction,
            "This question prompt is already being finalized.",
          );
          return null;
        }

        if (batch.domain.version !== action.version) {
          yield* replyToQuestionConflict(interaction, batch);
          return null;
        }

        switch (action.kind) {
          case "question-prev":
          case "question-next":
            return yield* routeQuestionUpdate(sessionId, interaction, action, (current) => ({
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
            return yield* routeQuestionUpdate(sessionId, interaction, action, (current) => {
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
            return yield* routeQuestionUpdate(sessionId, interaction, action, (current) =>
              setQuestionDraft(current, action.questionIndex, clearQuestionDraft()),
            );
          case "select":
            if (!interaction.isStringSelectMenu()) {
              return routedNoSignals(sessionId);
            }
            return yield* routeQuestionUpdate(sessionId, interaction, action, (current) => {
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
              return routedNoSignals(sessionId);
            }

            const question = yield* requireCustomQuestion(interaction, batch, action.questionIndex);
            if (!question) {
              return routedNoSignals(sessionId);
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
            return routedNoSignals(sessionId);
          }
          case "modal": {
            if (!interaction.isModalSubmit()) {
              return routedNoSignals(sessionId);
            }

            const question = yield* requireCustomQuestion(interaction, batch, action.questionIndex);
            if (!question) {
              return routedNoSignals(sessionId);
            }

            const customAnswer = readQuestionModalValue(interaction);
            if (!customAnswer) {
              yield* Effect.promise(() =>
                interaction.reply(questionInteractionReply("Custom answer cannot be empty.")),
              ).pipe(Effect.ignore);
              return routedNoSignals(sessionId);
            }

            const updated = yield* persistQuestionBatchOrReply({
              sessionId,
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
              return routedNoSignals(sessionId);
            }

            yield* editQuestionMessageLogged(
              updated,
              "failed to edit question batch after modal submit",
            );
            yield* Effect.promise(() => interaction.deferUpdate()).pipe(Effect.ignore);
            return routedNoSignals(sessionId);
          }
          case "submit":
          case "reject":
            if (!interaction.isButton()) {
              return routedNoSignals(sessionId);
            }
            return {
              sessionId,
              signals: yield* finalizeRemoteQuestionBatch(
                action.kind === "submit"
                  ? {
                      sessionId,
                      interaction,
                      requestId: action.requestID,
                      expectedVersion: action.version,
                      invoke: (session, requestId) =>
                        deps.replyToQuestion(
                          session,
                          requestId,
                          buildQuestionAnswers(batch.domain.request, batch.domain.drafts),
                        ),
                      followUpFailure: (error) =>
                        `Failed to submit answers: ${deps.formatError(error)}`,
                      onSuccess: () =>
                        finalizeQuestionBatch(
                          sessionId,
                          action.requestID,
                          "answered",
                          buildQuestionAnswers(batch.domain.request, batch.domain.drafts),
                        ),
                    }
                  : {
                      sessionId,
                      interaction,
                      requestId: action.requestID,
                      expectedVersion: action.version,
                      invoke: deps.rejectQuestion,
                      followUpFailure: (error) =>
                        `Failed to reject questions: ${deps.formatError(error)}`,
                      onSuccess: () =>
                        finalizeQuestionBatch(sessionId, action.requestID, "rejected").pipe(
                          Effect.map((signals) =>
                            appendSignals(
                              signals,
                              signal({
                                type: "set-run-question-outcome",
                                outcome: { _tag: "user-rejected" },
                              }),
                            ),
                          ),
                        ),
                    },
              ),
            } satisfies RoutedQuestionSignals;
        }
      });

    const rejectQuestionIdsForShutdown = (sessionId: string, requestIds: ReadonlyArray<string>) =>
      deps.getSessionContext(sessionId).pipe(
        Effect.flatMap((context) =>
          !context || requestIds.length === 0
            ? Effect.void
            : Effect.forEach(
                requestIds,
                (requestId) =>
                  deps.rejectQuestion(context.session.opencode, requestId).pipe(
                    Effect.timeoutOption(SHUTDOWN_QUESTION_RPC_TIMEOUT),
                    Effect.flatMap((result) =>
                      result._tag === "Some"
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
                  const failure = results.find((result) => result._tag === "Failure");
                  if (!failure) {
                    return Effect.void;
                  }

                  return deps.logger
                    .warn("question rejection was unresponsive during shutdown", {
                      sessionId,
                      error: deps.formatError(failure.failure),
                    })
                    .pipe(Effect.andThen(context.session.opencode.close()));
                }),
              ),
        ),
      );

    const editAttachedQuestionBatches = (batches: ReadonlyArray<QuestionWorkflowBatch>) =>
      Effect.forEach(
        batches,
        (batch) =>
          batch.runtime.attachment._tag !== "attached"
            ? Effect.void
            : editQuestionMessageLogged(batch, "failed to terminate question batch message"),
        { concurrency: "unbounded", discard: true },
      );

    const routeSignals = (
      sessionId: string,
      effect: Effect.Effect<ReadonlyArray<QuestionWorkflowSignal>, unknown>,
    ) => effect.pipe(Effect.map((signals) => ({ sessionId, signals })));

    const terminateSession = (sessionId: string) =>
      expirePendingBatches(sessionId).pipe(
        Effect.flatMap(({ terminated }) => editAttachedQuestionBatches(terminated)),
        Effect.as(noSignals),
      );

    const shutdownSession = (sessionId: string) =>
      markSessionStopped(sessionId).pipe(
        Effect.andThen(expirePendingBatches(sessionId, true)),
        Effect.tap(({ terminated }) => editAttachedQuestionBatches(terminated)),
        Effect.flatMap(({ requestIds }) => rejectQuestionIdsForShutdown(sessionId, requestIds)),
      );

    const cleanupShutdownQuestions = () =>
      readState().pipe(
        Effect.flatMap((state) =>
          Effect.forEach(state.sessions.keys(), shutdownSession, {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      );

    return {
      handleEvent: (event) =>
        getSessionState(event.sessionId).pipe(
          Effect.flatMap((sessionState) => {
            if (sessionState?.stopped) {
              return Effect.succeed(null);
            }

            switch (event.type) {
              case "asked":
                return deps
                  .getSessionContext(event.sessionId)
                  .pipe(
                    Effect.flatMap((context) =>
                      !context?.activeRun
                        ? Effect.succeed(null)
                        : routeSignals(
                            event.sessionId,
                            handleQuestionAsked(
                              event.sessionId,
                              context.session,
                              context.activeRun,
                              event.request,
                            ),
                          ),
                    ),
                  );
              case "replied":
                return routeSignals(
                  event.sessionId,
                  finalizeQuestionBatch(
                    event.sessionId,
                    event.requestId,
                    "answered",
                    event.answers,
                  ),
                );
              case "rejected":
                return routeSignals(
                  event.sessionId,
                  finalizeQuestionBatch(event.sessionId, event.requestId, "rejected"),
                );
            }
          }),
        ),
      routeInteraction: handleInteraction,
      hasPendingQuestions,
      hasPendingQuestionsAnywhere,
      terminateSession,
      shutdownSession,
      cleanupShutdownQuestions,
    } satisfies QuestionRuntime;
  });
