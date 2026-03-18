import { Deferred, Effect, FiberSet, Layer, Option, Queue, Ref, ServiceMap } from "effect";
import { type Interaction, type Message, type SendableChannels } from "discord.js";

import { AppConfig } from "@/config.ts";
import { InfoCards, makeInfoCards } from "@/discord/info-cards.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { parseQuestionActionId, questionInteractionReply } from "@/discord/question-card.ts";
import {
  buildOpencodePrompt,
  promptMessageContext,
  sendFinalResponse,
  startTypingLoop,
} from "@/discord/messages.ts";
import { OpencodeEventQueue } from "@/opencode/events.ts";
import type { Invocation } from "@/discord/triggers.ts";
import { OpencodeService } from "@/opencode/service.ts";
import { createCommandHandler } from "@/sessions/command-handler.ts";
import {
  IdleCompactionWorkflow,
  type IdleCompactionWorkflowShape,
  makeIdleCompactionWorkflow,
} from "@/sessions/idle-compaction-workflow.ts";
import { createEventHandler } from "@/sessions/event-handler.ts";
import { collectAttachmentMessages } from "@/sessions/message-context.ts";
import { coordinateActiveRunPrompts } from "@/sessions/prompt-coordinator.ts";
import { runProgressWorker } from "@/sessions/progress.ts";
import {
  createQuestionWorkflow,
  type QuestionWorkflow,
  type QuestionWorkflowEvent,
  type QuestionWorkflowSignal,
} from "@/sessions/question-coordinator.ts";
import { enqueueRunRequest } from "@/sessions/request-routing.ts";
import { executeRunBatch } from "@/sessions/run-executor.ts";
import { takeQueuedRunBatch } from "@/sessions/run-batch.ts";
import { SessionControl, makeSessionControl } from "@/sessions/session-control.ts";
import {
  createSessionLifecycle,
  type SessionLifecycleState,
} from "@/sessions/session-lifecycle.ts";
import { type ActiveRun, type ChannelSession, type RunRequest } from "@/sessions/session.ts";
import { defaultChannelSettings } from "@/state/channel-settings.ts";
import { formatError } from "@/util/errors.ts";
import { Logger } from "@/util/logging.ts";
import { resolveStatePaths } from "@/state/paths.ts";
import { SessionStore } from "@/state/store.ts";

export type ChannelSessionsShape = {
  submit: (message: Message, invocation: Invocation) => Effect.Effect<void, unknown>;
  getActiveRunBySessionId: (sessionId: string) => Effect.Effect<ActiveRun | null>;
  handleInteraction: (interaction: Interaction) => Effect.Effect<void, unknown>;
  shutdown: () => Effect.Effect<void, unknown>;
};

export class ChannelSessions extends ServiceMap.Service<ChannelSessions, ChannelSessionsShape>()(
  "ChannelSessions",
) {}
type FallibleEffect<A> = Effect.Effect<A, unknown>;

type ChannelSessionsState = SessionLifecycleState;
type WorkflowGate<A> = Deferred.Deferred<A, unknown>;
type WorkflowRegistryState<A> = {
  workflows: Map<string, A>;
  gates: Map<string, WorkflowGate<A>>;
};
type QuestionWorkflowGate = WorkflowGate<QuestionWorkflow>;
type QuestionWorkflowGateDecision =
  | { type: "existing"; workflow: QuestionWorkflow }
  | { type: "await"; gate: QuestionWorkflowGate }
  | { type: "create"; gate: QuestionWorkflowGate };

const SHUTDOWN_RPC_TIMEOUT = "1 second";
const SHUTDOWN_GRACE_PERIOD = "10 seconds";

const createChannelSessionsState = (): ChannelSessionsState => ({
  sessionsByChannelId: new Map(),
  sessionsBySessionId: new Map(),
  activeRunsBySessionId: new Map(),
  gatesByChannelId: new Map(),
});

const createWorkflowRegistryState = <A>(): WorkflowRegistryState<A> => ({
  workflows: new Map(),
  gates: new Map(),
});

export const ChannelSessionsLayer = Layer.effect(
  ChannelSessions,
  Effect.gen(function* () {
    const logger = yield* Logger;
    const config = yield* AppConfig;
    const opencode = yield* OpencodeService;
    const eventQueue = yield* OpencodeEventQueue;
    const sessionStore = yield* SessionStore;
    const stateRef = yield* Ref.make(createChannelSessionsState());
    const shutdownStartedRef = yield* Ref.make(false);
    const questionWorkflowsRef = yield* Ref.make(createWorkflowRegistryState<QuestionWorkflow>());
    const questionInteractionRoutesRef = yield* Ref.make(new Map<string, string>());
    const questionTypingPausedRef = yield* Ref.make(new Set<string>());
    const fiberSet = yield* FiberSet.make();
    const statePaths = resolveStatePaths(config.stateDir);
    const channelSettingsDefaults = defaultChannelSettings(config);
    const infoCards = makeInfoCards();
    let idleCompactionWorkflow: IdleCompactionWorkflowShape | null = null;

    const sendErrorReply = (message: Message, title: string, error: unknown) =>
      Effect.promise(() =>
        message.reply({
          content: formatErrorResponse(title, formatError(error)),
          allowedMentions: { repliedUser: false, parse: [] },
        }),
      );

    const sendRunFailure = (message: Message, error: unknown) =>
      sendErrorReply(message, "## ❌ Opencode failed", error);

    const sendQuestionUiFailure = (message: Message, error: unknown) =>
      sendErrorReply(message, "## ❌ Failed to show questions", error);

    const sessionLifecycle = createSessionLifecycle({
      stateRef,
      createOpencodeSession: opencode.createSession,
      attachOpencodeSession: opencode.attachSession,
      getPersistedSession: sessionStore.getSession,
      upsertPersistedSession: sessionStore.upsertSession,
      getPersistedChannelSettings: sessionStore.getChannelSettings,
      touchPersistedSession: sessionStore.touchSession,
      deletePersistedSession: sessionStore.deleteSession,
      isSessionHealthy: opencode.isHealthy,
      startWorker: (session) =>
        FiberSet.run(fiberSet, { startImmediately: true })(worker(session)).pipe(Effect.asVoid),
      logger,
      sessionInstructions: config.sessionInstructions,
      triggerPhrase: config.triggerPhrase,
      channelSettingsDefaults,
      idleTimeoutMs: config.sessionIdleTimeoutMs,
      sessionsRootDir: statePaths.sessionsRootDir,
      isSessionBusy: (session) =>
        idleCompactionWorkflow
          ? idleCompactionWorkflow.hasActive(session.opencode.sessionId)
          : Effect.succeed(false),
    });
    const {
      getSession,
      getActiveRunBySessionId,
      getSessionContext,
      setActiveRun,
      createOrGetSession,
      getOrRestoreSession,
      ensureSessionHealth,
      invalidateSession,
      closeExpiredSessions,
      shutdownSessions,
    } = sessionLifecycle;

    const trackQuestionRequest = (sessionId: string, requestId: string) =>
      Ref.update(questionInteractionRoutesRef, (current) => {
        const next = new Map(current);
        next.set(requestId, sessionId);
        return next;
      });

    const releaseQuestionRequest = (requestId: string) =>
      Ref.update(questionInteractionRoutesRef, (current) => {
        if (!current.has(requestId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(requestId);
        return next;
      });

    const getQuestionWorkflow = (sessionId: string) =>
      Ref.get(questionWorkflowsRef).pipe(
        Effect.map((state) => state.workflows.get(sessionId) ?? null),
      );

    const storeCreatedQuestionWorkflow = (
      sessionId: string,
      gate: QuestionWorkflowGate,
      workflow: QuestionWorkflow,
    ) =>
      Ref.update(questionWorkflowsRef, (current) => {
        if (current.gates.get(sessionId) !== gate) {
          return current;
        }

        const workflows = new Map(current.workflows);
        workflows.set(sessionId, workflow);
        const gates = new Map(current.gates);
        gates.delete(sessionId);
        return {
          workflows,
          gates,
        };
      });

    const clearQuestionWorkflowCreation = (sessionId: string, gate: QuestionWorkflowGate) =>
      Ref.update(questionWorkflowsRef, (current) => {
        if (current.gates.get(sessionId) !== gate) {
          return current;
        }

        const gates = new Map(current.gates);
        gates.delete(sessionId);
        return {
          ...current,
          gates,
        };
      });

    const getOrCreateQuestionWorkflow = (sessionId: string) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<QuestionWorkflow, unknown>();
        const decision = yield* Ref.modify(
          questionWorkflowsRef,
          (
            current,
          ): readonly [QuestionWorkflowGateDecision, WorkflowRegistryState<QuestionWorkflow>] => {
            const existing = current.workflows.get(sessionId);
            if (existing) {
              return [{ type: "existing", workflow: existing }, current];
            }

            const currentGate = current.gates.get(sessionId);
            if (currentGate) {
              return [{ type: "await", gate: currentGate }, current];
            }

            const gates = new Map(current.gates);
            gates.set(sessionId, gate);
            return [
              { type: "create", gate },
              {
                ...current,
                gates,
              },
            ];
          },
        );

        switch (decision.type) {
          case "existing":
            return decision.workflow;
          case "await":
            return yield* Deferred.await(decision.gate);
          case "create":
            break;
        }

        let workflow: QuestionWorkflow | null = null;
        const exit = yield* createQuestionWorkflow({
          getSessionContext: () => getSessionContext(sessionId),
          replyToQuestion: opencode.replyToQuestion,
          rejectQuestion: opencode.rejectQuestion,
          sendQuestionUiFailure,
          trackRequestId: (requestId: string) => trackQuestionRequest(sessionId, requestId),
          releaseRequestId: releaseQuestionRequest,
          onDrained: () => (workflow ? deleteQuestionWorkflow(sessionId, workflow) : Effect.void),
          logger,
          formatError,
        }).pipe(
          Effect.tap((created) =>
            Effect.sync(() => {
              workflow = created;
            }).pipe(
              Effect.andThen(storeCreatedQuestionWorkflow(sessionId, decision.gate, created)),
            ),
          ),
          Effect.exit,
        );

        yield* Deferred.done(decision.gate, exit).pipe(Effect.ignore);
        if (exit._tag === "Failure") {
          yield* clearQuestionWorkflowCreation(sessionId, decision.gate);
          return yield* Effect.failCause(exit.cause);
        }
        return exit.value;
      });

    const deleteQuestionWorkflow = (sessionId: string, workflow?: QuestionWorkflow) =>
      Ref.update(questionWorkflowsRef, (current) => {
        const existing = current.workflows.get(sessionId);
        if (!existing || (workflow && existing !== workflow)) {
          return current;
        }

        const workflows = new Map(current.workflows);
        workflows.delete(sessionId);
        return {
          ...current,
          workflows,
        };
      });

    const hasPendingQuestions = (sessionId: string) =>
      getQuestionWorkflow(sessionId).pipe(
        Effect.flatMap((workflow) =>
          workflow ? workflow.hasPendingQuestions() : Effect.succeed(false),
        ),
      );

    const reconcileQuestionTypingForSession = (sessionId: string) =>
      getSessionContext(sessionId).pipe(
        Effect.flatMap((context) => {
          const activeRun = context?.activeRun ?? null;
          if (!activeRun) {
            return Ref.update(questionTypingPausedRef, (current) => {
              if (!current.has(sessionId)) {
                return current;
              }
              const next = new Set(current);
              next.delete(sessionId);
              return next;
            });
          }

          return hasPendingQuestions(sessionId).pipe(
            Effect.flatMap((pending) =>
              Ref.modify(questionTypingPausedRef, (current) => {
                const wasPaused = current.has(sessionId);
                if (pending === wasPaused) {
                  return [{ pending, wasPaused }, current] as const;
                }

                const next = new Set(current);
                if (pending) {
                  next.add(sessionId);
                } else {
                  next.delete(sessionId);
                }
                return [{ pending, wasPaused }, next] as const;
              }).pipe(
                Effect.flatMap(({ pending, wasPaused }) =>
                  pending
                    ? wasPaused
                      ? Effect.void
                      : Effect.promise(() => activeRun.typing.pause()).pipe(
                          Effect.timeoutOption("1 second"),
                          Effect.flatMap((result) =>
                            Option.isSome(result)
                              ? Effect.void
                              : logger.warn(
                                  "typing pause timed out while question prompt was active",
                                  {
                                    channelId: activeRun.originMessage.channelId,
                                    sessionId,
                                  },
                                ),
                          ),
                        )
                    : wasPaused
                      ? activeRun.questionOutcome._tag !== "none" || activeRun.interruptRequested
                        ? Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore)
                        : Effect.sync(() => {
                            activeRun.typing.resume();
                          })
                      : activeRun.questionOutcome._tag !== "none" || activeRun.interruptRequested
                        ? Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore)
                        : Effect.void,
                ),
              ),
            ),
          );
        }),
      );

    const applyQuestionSignals = (
      sessionId: string,
      signals: ReadonlyArray<QuestionWorkflowSignal>,
    ) =>
      Effect.forEach(
        signals,
        (item) =>
          getSessionContext(sessionId).pipe(
            Effect.flatMap((context) => {
              const activeRun = context?.activeRun ?? null;
              switch (item.type) {
                case "clear-run-interrupt":
                  return !activeRun
                    ? Effect.void
                    : Effect.sync(() => {
                        activeRun.interruptRequested = false;
                        activeRun.interruptSource = null;
                      });
                case "set-run-question-outcome":
                  return !activeRun
                    ? Effect.void
                    : Effect.sync(() => {
                        activeRun.questionOutcome = item.outcome;
                      });
              }
            }),
          ),
        { concurrency: "unbounded", discard: true },
      );

    const applyQuestionWorkflowSignals = (
      sessionId: string,
      signals: ReadonlyArray<QuestionWorkflowSignal>,
    ) =>
      applyQuestionSignals(sessionId, signals).pipe(
        Effect.andThen(reconcileQuestionTypingForSession(sessionId)),
      );

    const handleQuestionEvent = (
      event: {
        sessionId: string;
      } & QuestionWorkflowEvent,
    ) =>
      Effect.gen(function* () {
        const workflow =
          event.type === "asked"
            ? yield* getOrCreateQuestionWorkflow(event.sessionId)
            : yield* getQuestionWorkflow(event.sessionId);
        if (!workflow) {
          return;
        }

        const signals = yield* workflow.handleEvent(
          event.type === "asked"
            ? { type: "asked", request: event.request }
            : event.type === "replied"
              ? {
                  type: "replied",
                  requestId: event.requestId,
                  answers: event.answers,
                }
              : { type: "rejected", requestId: event.requestId },
        );
        yield* applyQuestionWorkflowSignals(event.sessionId, signals);
      });

    const routeQuestionInteraction = (interaction: Interaction) =>
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

        const sessionId = yield* Ref.get(questionInteractionRoutesRef).pipe(
          Effect.map((routes) => routes.get(action.requestID) ?? null),
        );
        if (!sessionId) {
          if (!interaction.replied && !interaction.deferred) {
            yield* Effect.promise(() =>
              interaction.reply(questionInteractionReply("This question prompt has expired.")),
            ).pipe(Effect.ignore);
          }
          return;
        }

        const workflow = yield* getQuestionWorkflow(sessionId);
        if (!workflow) {
          return;
        }

        const signals = yield* workflow.handleInteraction(interaction);
        yield* applyQuestionWorkflowSignals(sessionId, signals);
      });

    const sessionControl = makeSessionControl({
      getLoaded: (channelId) =>
        getSession(channelId).pipe(Effect.map((session) => session ?? null)),
      getOrRestore: getOrRestoreSession,
      invalidate: invalidateSession,
      hasPendingQuestions,
    });
    const serviceLayer = Layer.mergeAll(
      Layer.succeed(Logger, logger),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(OpencodeService, opencode),
    );
    idleCompactionWorkflow = yield* makeIdleCompactionWorkflow().pipe(Effect.provide(serviceLayer));
    const commandLayer = Layer.mergeAll(
      Layer.succeed(AppConfig, config),
      Layer.succeed(IdleCompactionWorkflow, idleCompactionWorkflow),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(OpencodeService, opencode),
      Layer.succeed(SessionControl, sessionControl),
      Layer.succeed(SessionStore, sessionStore),
      Layer.succeed(Logger, logger),
    );

    const eventHandler = createEventHandler({
      getSessionContext,
      handleQuestionEvent,
      idleCompactionWorkflow,
      readPromptResult: opencode.readPromptResult,
      logger,
      formatError,
    });

    yield* Queue.take(eventQueue).pipe(
      Effect.flatMap((wrapped) => eventHandler.handleEvent(wrapped.payload)),
      Effect.forever,
      Effect.catch((error) =>
        logger.error("opencode event dispatcher failed", {
          error: formatError(error),
        }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.sleep(60_000).pipe(
      Effect.andThen(closeExpiredSessions()),
      Effect.forever,
      Effect.catch((error) =>
        logger.error("idle session sweeper failed", {
          error: formatError(error),
        }),
      ),
      Effect.forkScoped,
    );

    const runExecutor = executeRunBatch({
      runPrompts: ({ channelId, session, activeRun, initialRequests, handlePromptCompleted }) =>
        coordinateActiveRunPrompts({
          channelId,
          session,
          activeRun,
          initialRequests,
          awaitIdleCompaction: idleCompactionWorkflow.awaitCompletion,
          submitPrompt: opencode.submitPrompt,
          handlePromptCompleted,
          logger,
        }),
      runProgressWorker,
      startTyping: (message) => startTypingLoop(message.channel),
      setActiveRun,
      terminateQuestionBatches: (sessionId) =>
        getQuestionWorkflow(sessionId).pipe(
          Effect.flatMap((workflow) =>
            !workflow
              ? Effect.void
              : workflow
                  .terminate()
                  .pipe(
                    Effect.flatMap((signals) => applyQuestionWorkflowSignals(sessionId, signals)),
                  ),
          ),
        ),
      ensureSessionHealthAfterFailure: (session, responseMessage) =>
        ensureSessionHealth(
          session,
          responseMessage,
          "run failed with unhealthy opencode session",
          false,
        ),
      sendRunInterruptedInfo: (message, source) =>
        infoCards
          .send(
            message.channel as SendableChannels,
            source === "shutdown" ? "🛑 Run interrupted" : "‼️ Run interrupted",
            source === "shutdown"
              ? "OpenCode stopped the active run in this channel because the bot is shutting down."
              : "OpenCode stopped the active run in this channel.",
          )
          .pipe(
            Effect.catch((error) =>
              logger.warn("failed to post interrupt info card", {
                channelId: message.channelId,
                error: formatError(error),
              }),
            ),
            Effect.ignore,
          ),
      sendFinalResponse: (message, text) =>
        Effect.promise(() => sendFinalResponse({ message, text })),
      sendRunFailure,
      sendQuestionUiFailure,
      logger,
      formatError,
    });

    const worker = (session: ChannelSession): Effect.Effect<never> =>
      Effect.forever(
        takeQueuedRunBatch(session.queue).pipe(
          Effect.flatMap((requests) => runExecutor(session, requests)),
          Effect.catch((error) =>
            logger.error("channel worker iteration failed", {
              channelId: session.channelId,
              error: formatError(error),
            }),
          ),
        ),
      );

    const commandHandler = createCommandHandler({
      commandLayer,
    });

    const getUsableSession = (message: Message, reason: string): FallibleEffect<ChannelSession> =>
      createOrGetSession(message).pipe(
        Effect.flatMap((session) => ensureSessionHealth(session, message, reason)),
      );

    const withShutdownRpcTimeout =
      (message: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Error, R> =>
        effect.pipe(
          Effect.timeoutOption(SHUTDOWN_RPC_TIMEOUT),
          Effect.flatMap((result) =>
            Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(new Error(message)),
          ),
        );

    const startShutdown = (): Effect.Effect<boolean> =>
      Ref.modify(shutdownStartedRef, (started): readonly [boolean, boolean] =>
        started ? [false, true] : [true, true],
      );

    const forceCloseSessionHandle = (session: ChannelSession, reason: string) =>
      session.opencode.close().pipe(
        Effect.catch((error) =>
          logger.warn("failed to force-close opencode session during shutdown", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            reason,
            error: formatError(error),
          }),
        ),
      );

    const rejectPendingQuestionsForShutdown = (session: ChannelSession) =>
      Effect.gen(function* () {
        const workflow = yield* getQuestionWorkflow(session.opencode.sessionId);
        if (!workflow) {
          return;
        }

        const shutdownState = yield* workflow.shutdown();
        yield* applyQuestionWorkflowSignals(session.opencode.sessionId, shutdownState.signals);

        if (shutdownState.requestIds.length === 0) {
          return;
        }

        const results = yield* Effect.forEach(
          shutdownState.requestIds,
          (requestId) =>
            opencode
              .rejectQuestion(session.opencode, requestId)
              .pipe(
                withShutdownRpcTimeout(`Timed out rejecting question ${requestId}`),
                Effect.result,
              ),
          { concurrency: "unbounded", discard: false },
        );

        const failure = results.find((result) => result._tag === "Failure");
        if (!failure) {
          return;
        }

        yield* logger.warn("question rejection was unresponsive during shutdown", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          error: formatError(failure.failure),
        });
        yield* forceCloseSessionHandle(session, "question rejection timed out or failed");
      });

    const interruptRunForShutdown = (session: ChannelSession, activeRun: ActiveRun) =>
      Effect.gen(function* () {
        activeRun.interruptRequested = true;
        activeRun.interruptSource = "shutdown";

        const result = yield* opencode
          .interruptSession(session.opencode)
          .pipe(
            withShutdownRpcTimeout("Timed out interrupting active run during shutdown"),
            Effect.result,
          );
        if (result._tag === "Success") {
          return;
        }

        yield* logger.warn("run interrupt was unresponsive during shutdown", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          error: formatError(result.failure),
        });
        yield* forceCloseSessionHandle(session, "run interrupt timed out or failed");
      });

    const interruptIdleCompactionForShutdown = (session: ChannelSession) =>
      idleCompactionWorkflow.requestInterrupt({ session }).pipe(
        withShutdownRpcTimeout("Timed out interrupting idle compaction during shutdown"),
        Effect.flatMap((result) =>
          result.type === "failed" ? Effect.fail(new Error(result.message)) : Effect.void,
        ),
        Effect.catch((error) =>
          logger
            .warn("idle compaction interrupt was unresponsive during shutdown", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              error: formatError(error),
            })
            .pipe(
              Effect.andThen(
                forceCloseSessionHandle(session, "idle compaction interrupt timed out or failed"),
              ),
            ),
        ),
      );

    const requestSessionShutdown = (session: ChannelSession) =>
      Effect.gen(function* () {
        yield* rejectPendingQuestionsForShutdown(session);

        if (session.activeRun) {
          yield* interruptRunForShutdown(session, session.activeRun);
          return;
        }

        if (yield* idleCompactionWorkflow.hasActive(session.opencode.sessionId)) {
          yield* interruptIdleCompactionForShutdown(session);
        }
      });

    const awaitShutdownDrain = () =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const hasActiveRuns = state.activeRunsBySessionId.size > 0;
        const sessionIds = [...state.sessionsBySessionId.keys()];
        const hasIdleCompactions =
          sessionIds.length === 0
            ? false
            : (yield* Effect.forEach(
                sessionIds,
                (sessionId) => idleCompactionWorkflow.hasActive(sessionId),
                { concurrency: "unbounded", discard: false },
              )).some(Boolean);
        const workflows = [...(yield* Ref.get(questionWorkflowsRef)).workflows.entries()];
        const hasPendingQuestions =
          workflows.length === 0
            ? false
            : (yield* Effect.forEach(workflows, ([, workflow]) => workflow.hasPendingQuestions(), {
                concurrency: "unbounded",
                discard: false,
              })).some(Boolean);

        if (hasActiveRuns || hasIdleCompactions || hasPendingQuestions) {
          return yield* Effect.fail(new Error("shutdown work is still draining"));
        }
      }).pipe(Effect.eventually, Effect.timeoutOption(SHUTDOWN_GRACE_PERIOD));

    const finalizeLingeringShutdownUi = () =>
      Effect.gen(function* () {
        const questionWorkflows = [...(yield* Ref.get(questionWorkflowsRef)).workflows.entries()];
        yield* Effect.forEach(
          questionWorkflows,
          ([sessionId, workflow]) =>
            workflow.shutdown().pipe(
              Effect.flatMap((state) => applyQuestionWorkflowSignals(sessionId, state.signals)),
              Effect.catch((error) =>
                logger.warn("failed to expire pending questions during shutdown", {
                  sessionId,
                  error: formatError(error),
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );

        const state = yield* Ref.get(stateRef);
        const activeRuns = [...state.activeRunsBySessionId.entries()];
        const idleCompactionSessionIds = (yield* Effect.forEach(
          state.sessionsBySessionId.keys(),
          (sessionId) =>
            idleCompactionWorkflow
              .hasActive(sessionId)
              .pipe(Effect.map((active) => (active ? sessionId : null))),
          { concurrency: "unbounded", discard: false },
        )).filter((sessionId): sessionId is string => sessionId !== null);

        yield* Effect.forEach(
          activeRuns,
          ([sessionId, activeRun]) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore);
              yield* activeRun.finalizeProgress("interrupted").pipe(
                Effect.catch((error) =>
                  logger.warn("failed to finalize interrupted run progress during shutdown", {
                    sessionId,
                    error: formatError(error),
                  }),
                ),
              );
              yield* infoCards
                .send(
                  activeRun.originMessage.channel as SendableChannels,
                  "🛑 Run interrupted",
                  "OpenCode stopped the active run in this channel because the bot is shutting down.",
                )
                .pipe(
                  Effect.catch((error) =>
                    logger.warn("failed to post shutdown interrupt info card", {
                      channelId: activeRun.originMessage.channelId,
                      sessionId,
                      error: formatError(error),
                    }),
                  ),
                  Effect.ignore,
                );
            }),
          { concurrency: "unbounded", discard: true },
        );

        yield* Effect.forEach(
          idleCompactionSessionIds,
          (sessionId) =>
            idleCompactionWorkflow.handleInterrupted(sessionId).pipe(
              Effect.catch((error) =>
                logger.warn("failed to finalize idle compaction on shutdown", {
                  sessionId,
                  error: formatError(error),
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );
      });

    const shutdown: ChannelSessionsShape["shutdown"] = () =>
      startShutdown().pipe(
        Effect.flatMap((shouldRun) =>
          !shouldRun
            ? Effect.void
            : Effect.gen(function* () {
                const questionWorkflows = [
                  ...(yield* Ref.get(questionWorkflowsRef)).workflows.values(),
                ];
                yield* Effect.forEach(questionWorkflows, (workflow) => workflow.beginShutdown(), {
                  concurrency: "unbounded",
                  discard: true,
                }).pipe(
                  Effect.catch((error) =>
                    logger.warn("failed to begin question workflow shutdown", {
                      error: formatError(error),
                    }),
                  ),
                );

                yield* idleCompactionWorkflow.shutdown().pipe(
                  Effect.catch((error) =>
                    logger.warn("failed to begin idle compaction shutdown", {
                      error: formatError(error),
                    }),
                  ),
                );

                const state = yield* Ref.get(stateRef);
                const sessions = [...state.sessionsBySessionId.values()];
                yield* Effect.forEach(sessions, requestSessionShutdown, {
                  concurrency: "unbounded",
                  discard: true,
                });

                yield* awaitShutdownDrain();
                yield* finalizeLingeringShutdownUi();

                yield* FiberSet.clear(fiberSet).pipe(
                  Effect.catch((error) =>
                    logger.warn("failed to interrupt session workers on shutdown", {
                      error: formatError(error),
                    }),
                  ),
                );
                yield* shutdownSessions().pipe(
                  Effect.catch((error) =>
                    logger.warn("failed to shut down sessions", {
                      error: formatError(error),
                    }),
                  ),
                );
              }),
        ),
        Effect.catch((error) =>
          logger.warn("channel sessions shutdown failed", {
            error: formatError(error),
          }),
        ),
      );

    return {
      submit: (message, invocation): FallibleEffect<void> =>
        Ref.get(shutdownStartedRef).pipe(
          Effect.flatMap((shutdownStarted) =>
            shutdownStarted
              ? Effect.void
              : Effect.acquireUseRelease(
                  Effect.sync(() => startTypingLoop(message.channel)),
                  () =>
                    Effect.gen(function* () {
                      const session = yield* getUsableSession(
                        message,
                        "health probe failed before queueing run",
                      );
                      session.progressChannel = message.channel.isSendable()
                        ? (message.channel as SendableChannels)
                        : null;
                      session.progressMentionContext = message;
                      const attachmentMessages = yield* collectAttachmentMessages(message);
                      const referencedMessage =
                        attachmentMessages.find((candidate) => candidate.id !== message.id) ?? null;
                      const prompt = buildOpencodePrompt({
                        message: promptMessageContext(message, invocation.prompt),
                        referencedMessage: referencedMessage
                          ? promptMessageContext(referencedMessage)
                          : undefined,
                      });

                      const request = {
                        message,
                        prompt,
                        attachmentMessages,
                      } satisfies RunRequest;

                      const destination = yield* enqueueRunRequest(session, request);
                      if (destination === "follow-up") {
                        yield* logger.info("queued follow-up on active run", {
                          channelId: message.channelId,
                          sessionId: session.opencode.sessionId,
                          author: message.author.tag,
                        });
                      } else {
                        yield* logger.info("queued run", {
                          channelId: message.channelId,
                          sessionId: session.opencode.sessionId,
                          author: message.author.tag,
                        });
                      }
                    }),
                  (typing) => Effect.promise(() => typing.stop()).pipe(Effect.ignore),
                ),
          ),
        ),
      getActiveRunBySessionId,
      handleInteraction: (interaction) =>
        Ref.get(shutdownStartedRef).pipe(
          Effect.flatMap((shutdownStarted) =>
            interaction.isChatInputCommand()
              ? shutdownStarted
                ? Effect.void
                : commandHandler.handleInteraction(interaction)
              : interaction.isButton() ||
                  interaction.isStringSelectMenu() ||
                  interaction.isModalSubmit()
                ? routeQuestionInteraction(interaction)
                : Effect.void,
          ),
        ),
      shutdown,
    } satisfies ChannelSessionsShape;
  }),
);
