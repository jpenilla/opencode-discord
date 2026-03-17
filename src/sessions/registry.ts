import { Effect, FiberSet, Layer, Option, Queue, Ref, ServiceMap } from "effect";
import { type Interaction, type Message, type SendableChannels } from "discord.js";

import { AppConfig } from "@/config.ts";
import { InfoCards, makeInfoCards } from "@/discord/info-cards.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
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
  makeIdleCompactionWorkflow,
} from "@/sessions/idle-compaction-workflow.ts";
import { createEventHandler } from "@/sessions/event-handler.ts";
import { collectAttachmentMessages } from "@/sessions/message-context.ts";
import { coordinateActiveRunPrompts } from "@/sessions/prompt-coordinator.ts";
import { QuestionStatus, makeQuestionStatus } from "@/sessions/question-status.ts";
import { runProgressWorker } from "@/sessions/progress.ts";
import { createQuestionCoordinator } from "@/sessions/question-coordinator.ts";
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

const SHUTDOWN_RPC_TIMEOUT = "1 second";
const SHUTDOWN_GRACE_PERIOD = "10 seconds";

const createChannelSessionsState = (): ChannelSessionsState => ({
  sessionsByChannelId: new Map(),
  sessionsBySessionId: new Map(),
  activeRunsBySessionId: new Map(),
  gatesByChannelId: new Map(),
  idleCompactionsBySessionId: new Map(),
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
    const fiberSet = yield* FiberSet.make();
    const statePaths = resolveStatePaths(config.stateDir);
    const channelSettingsDefaults = defaultChannelSettings(config);
    const infoCards = makeInfoCards();

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
    });
    const {
      getSession,
      getActiveRunBySessionId,
      getSessionContext,
      hasIdleCompaction,
      awaitIdleCompaction,
      setActiveRun,
      beginIdleCompaction,
      setIdleCompactionCard,
      setIdleCompactionInterruptRequested,
      completeIdleCompaction,
      createOrGetSession,
      getOrRestoreSession,
      ensureSessionHealth,
      invalidateSession,
      closeExpiredSessions,
      shutdownSessions,
    } = sessionLifecycle;

    const questionCoordinator = yield* createQuestionCoordinator({
      getSessionContext,
      replyToQuestion: opencode.replyToQuestion,
      rejectQuestion: opencode.rejectQuestion,
      sendQuestionUiFailure,
      logger,
      formatError,
    });

    const questionStatus = makeQuestionStatus(questionCoordinator.hasPendingQuestionsForSession);
    const sessionControl = makeSessionControl({
      getLoaded: (channelId) =>
        getSession(channelId).pipe(Effect.map((session) => session ?? null)),
      getOrRestore: getOrRestoreSession,
      invalidate: invalidateSession,
    });
    const serviceLayer = Layer.mergeAll(
      Layer.succeed(Logger, logger),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(OpencodeService, opencode),
    );
    const idleCompactionWorkflow = yield* makeIdleCompactionWorkflow({
      hasIdleCompaction,
      beginIdleCompaction,
      getIdleCompactionCard: sessionLifecycle.getIdleCompactionCard,
      setIdleCompactionCard,
      completeIdleCompaction,
      setIdleCompactionInterruptRequested,
      getIdleCompactionInterruptRequested: sessionLifecycle.getIdleCompactionInterruptRequested,
    }).pipe(Effect.provide(serviceLayer));
    const commandLayer = Layer.mergeAll(
      Layer.succeed(AppConfig, config),
      Layer.succeed(IdleCompactionWorkflow, idleCompactionWorkflow),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(OpencodeService, opencode),
      Layer.succeed(QuestionStatus, questionStatus),
      Layer.succeed(SessionControl, sessionControl),
      Layer.succeed(SessionStore, sessionStore),
      Layer.succeed(Logger, logger),
    );

    const eventHandler = createEventHandler({
      getSessionContext,
      handleQuestionEvent: questionCoordinator.handleEvent,
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
          awaitIdleCompaction,
          submitPrompt: opencode.submitPrompt,
          handlePromptCompleted,
          logger,
        }),
      runProgressWorker,
      startTyping: (message) => startTypingLoop(message.channel),
      setActiveRun,
      terminateQuestionBatches: questionCoordinator.terminateForSession,
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
            "‼️ Run interrupted",
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
        const requestIds = yield* questionCoordinator.getPendingRequestIdsForSession(
          session.opencode.sessionId,
        );
        yield* questionCoordinator.markShutdownRejectedRequests(requestIds);

        if (requestIds.length === 0) {
          return;
        }

        const results = yield* Effect.forEach(
          requestIds,
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

        if (yield* hasIdleCompaction(session.opencode.sessionId)) {
          yield* interruptIdleCompactionForShutdown(session);
        }
      });

    const awaitShutdownDrain = () =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const sessionIds = [...state.sessionsBySessionId.keys()];
        const hasActiveRuns = state.activeRunsBySessionId.size > 0;
        const hasIdleCompactions = state.idleCompactionsBySessionId.size > 0;
        const hasPendingQuestions =
          sessionIds.length === 0
            ? false
            : (yield* Effect.forEach(
                sessionIds,
                (sessionId) => questionCoordinator.hasPendingQuestionsForSession(sessionId),
                { concurrency: "unbounded", discard: false },
              )).some(Boolean);

        if (hasActiveRuns || hasIdleCompactions || hasPendingQuestions) {
          return yield* Effect.fail(new Error("shutdown work is still draining"));
        }
      }).pipe(Effect.eventually, Effect.timeoutOption(SHUTDOWN_GRACE_PERIOD));

    const finalizeLingeringShutdownUi = () =>
      Effect.gen(function* () {
        yield* questionCoordinator.shutdown().pipe(
          Effect.catch((error) =>
            logger.warn("failed to expire pending questions during shutdown", {
              error: formatError(error),
            }),
          ),
        );

        const state = yield* Ref.get(stateRef);
        const activeRuns = [...state.activeRunsBySessionId.entries()];
        const idleCompactions = [...state.idleCompactionsBySessionId.entries()];

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
                  "‼️ Run interrupted",
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
          idleCompactions,
          ([sessionId, idleCompaction]) =>
            (idleCompaction.interruptRequested
              ? idleCompactionWorkflow.handleInterrupted(sessionId)
              : idleCompactionWorkflow.handleStopped(sessionId)
            ).pipe(
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
                yield* questionCoordinator.beginShutdown().pipe(
                  Effect.catch((error) =>
                    logger.warn("failed to begin question coordinator shutdown", {
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
                ? questionCoordinator.handleInteraction(interaction)
                : Effect.void,
          ),
        ),
      shutdown,
    } satisfies ChannelSessionsShape;
  }),
);
