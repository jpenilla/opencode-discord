import { Effect, FiberSet, Layer, Queue, Ref, ServiceMap } from "effect";
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
  handleInteraction: (interaction: Interaction) => Effect.Effect<boolean, unknown>;
  shutdown: () => Effect.Effect<void, unknown>;
};

export class ChannelSessions extends ServiceMap.Service<ChannelSessions, ChannelSessionsShape>()(
  "ChannelSessions",
) {}
type FallibleEffect<A> = Effect.Effect<A, unknown>;

type ChannelSessionsState = SessionLifecycleState;

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
      sendRunInterruptedInfo: (message) =>
        infoCards
          .send(
            message.channel as SendableChannels,
            "‼️ Run interrupted",
            "OpenCode stopped the active run in this channel.",
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

    const shutdown = () =>
      Ref.modify(shutdownStartedRef, (started): readonly [Effect.Effect<void, unknown>, boolean] =>
        started
          ? [Effect.void, true]
          : [
              Effect.gen(function* () {
                const state = yield* Ref.get(stateRef);
                const activeRuns = [...state.activeRunsBySessionId.entries()];
                const idleCompactionIds = [...state.idleCompactionsBySessionId.keys()];

                yield* questionCoordinator.shutdown().pipe(
                  Effect.catch((error) =>
                    logger.warn("failed to shut down question coordinator", {
                      error: formatError(error),
                    }),
                  ),
                );

                yield* Effect.forEach(
                  activeRuns,
                  ([sessionId, activeRun]) =>
                    Effect.gen(function* () {
                      yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore);
                      yield* activeRun.finalizeProgress("shutdown").pipe(
                        Effect.catch((error) =>
                          logger.warn("failed to finalize active run progress on shutdown", {
                            sessionId,
                            error: formatError(error),
                          }),
                        ),
                      );
                    }),
                  { concurrency: "unbounded", discard: true },
                );

                yield* idleCompactionWorkflow.shutdown().pipe(
                  Effect.catch((error) =>
                    logger.warn("failed to shut down idle compaction workflow", {
                      error: formatError(error),
                    }),
                  ),
                );

                yield* Effect.forEach(
                  idleCompactionIds,
                  (sessionId) =>
                    idleCompactionWorkflow.handleStopped(sessionId).pipe(
                      Effect.catch((error) =>
                        logger.warn("failed to finalize idle compaction on shutdown", {
                          sessionId,
                          error: formatError(error),
                        }),
                      ),
                    ),
                  { concurrency: "unbounded", discard: true },
                );

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
              true,
            ],
      ).pipe(
        Effect.flatten,
        Effect.catch((error) =>
          logger.warn("channel sessions shutdown failed", {
            error: formatError(error),
          }),
        ),
      );

    yield* Effect.addFinalizer(() => shutdown());

    return {
      submit: (message, invocation): FallibleEffect<void> =>
        Effect.acquireUseRelease(
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
      getActiveRunBySessionId,
      handleInteraction: (interaction) =>
        commandHandler
          .handleInteraction(interaction)
          .pipe(
            Effect.flatMap((handled) =>
              handled ? Effect.succeed(true) : questionCoordinator.handleInteraction(interaction),
            ),
          ),
      shutdown,
    } satisfies ChannelSessionsShape;
  }),
);
