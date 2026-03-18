import { Effect, FiberSet, Layer, Option, Queue, Ref, ServiceMap } from "effect";
import { type Interaction, type Message, type SendableChannels } from "discord.js";

import { AppConfig } from "@/config.ts";
import { createCommandHandler } from "@/sessions/command-handler.ts";
import { InfoCards, makeInfoCards } from "@/discord/info-cards.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import {
  buildOpencodePrompt,
  promptMessageContext,
  sendFinalResponse,
  startTypingLoop,
} from "@/discord/messages.ts";
import type { Invocation } from "@/discord/triggers.ts";
import { OpencodeEventQueue } from "@/opencode/events.ts";
import { OpencodeService } from "@/opencode/service.ts";
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
  type QuestionWorkflowEvent,
  type QuestionWorkflowSignal,
} from "@/sessions/question-coordinator.ts";
import { makeQuestionRuntime, type QuestionRuntime } from "@/sessions/question-runtime.ts";
import { enqueueRunRequest } from "@/sessions/request-routing.ts";
import { executeRunBatch } from "@/sessions/run-executor.ts";
import { takeQueuedRunBatch } from "@/sessions/run-batch.ts";
import {
  createSessionLifecycle,
  makeSessionRuntime,
  SessionRuntime,
  type SessionLifecycleState,
  type SessionRuntimeShape,
} from "@/sessions/session-runtime.ts";
import { createSessionShutdown } from "@/sessions/session-shutdown.ts";
import { type ActiveRun, type ChannelSession, type RunRequest } from "@/sessions/session.ts";
import { defaultChannelSettings } from "@/state/channel-settings.ts";
import { formatError } from "@/util/errors.ts";
import { Logger } from "@/util/logging.ts";
import { resolveStatePaths } from "@/state/paths.ts";
import { SessionStore } from "@/state/store.ts";

export type ChannelRuntimeShape = {
  submit: (message: Message, invocation: Invocation) => Effect.Effect<void, unknown>;
  getActiveRunBySessionId: (sessionId: string) => Effect.Effect<ActiveRun | null, unknown>;
  handleInteraction: (interaction: Interaction) => Effect.Effect<void, unknown>;
  shutdown: () => Effect.Effect<void, unknown>;
};

export class ChannelRuntime extends ServiceMap.Service<ChannelRuntime, ChannelRuntimeShape>()(
  "ChannelRuntime",
) {}
type FallibleEffect<A> = Effect.Effect<A, unknown>;

type ChannelRuntimeState = SessionLifecycleState;

const createChannelRuntimeState = (): ChannelRuntimeState => ({
  sessionsByChannelId: new Map(),
  sessionsBySessionId: new Map(),
  activeRunsBySessionId: new Map(),
  gatesByChannelId: new Map(),
});

export const ChannelRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const logger = yield* Logger;
    const config = yield* AppConfig;
    const opencode = yield* OpencodeService;
    const eventQueue = yield* OpencodeEventQueue;
    const sessionStore = yield* SessionStore;
    const stateRef = yield* Ref.make(createChannelRuntimeState());
    const shutdownStartedRef = yield* Ref.make(false);
    const questionTypingPausedRef = yield* Ref.make(new Set<string>());
    const fiberSet = yield* FiberSet.make();
    const statePaths = resolveStatePaths(config.stateDir);
    const channelSettingsDefaults = defaultChannelSettings(config);
    const infoCards = makeInfoCards();
    let idleCompactionWorkflow: IdleCompactionWorkflowShape | null = null;
    let questionRuntime: QuestionRuntime | null = null;
    const isSessionBusy = (session: ChannelSession) =>
      session.activeRun
        ? Effect.succeed(true)
        : Effect.gen(function* () {
            const hasPendingQuestions = questionRuntime
              ? yield* questionRuntime.hasPendingQuestions(session.opencode.sessionId)
              : false;
            if (hasPendingQuestions) {
              return true;
            }
            return idleCompactionWorkflow
              ? yield* idleCompactionWorkflow.hasActive(session.opencode.sessionId)
              : false;
          });

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
      isSessionBusy,
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
    questionRuntime = yield* makeQuestionRuntime({
      getSessionContext,
      replyToQuestion: opencode.replyToQuestion,
      rejectQuestion: opencode.rejectQuestion,
      sendQuestionUiFailure,
      logger,
      formatError,
    });

    const hasPendingQuestions = (sessionId: string) =>
      questionRuntime.hasPendingQuestions(sessionId);

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
        const routed = yield* questionRuntime.handleEvent(event);
        if (!routed) {
          return;
        }
        yield* applyQuestionWorkflowSignals(routed.sessionId, routed.signals);
      });

    const routeQuestionInteraction = (interaction: Interaction) =>
      Effect.gen(function* () {
        const routed = yield* questionRuntime.routeInteraction(interaction);
        if (!routed) {
          return;
        }
        yield* applyQuestionWorkflowSignals(routed.sessionId, routed.signals);
      });

    const serviceLayer = Layer.mergeAll(
      Layer.succeed(Logger, logger),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(OpencodeService, opencode),
    );
    idleCompactionWorkflow = yield* makeIdleCompactionWorkflow().pipe(Effect.provide(serviceLayer));

    const eventHandler = createEventHandler({
      getSessionContext,
      handleQuestionEvent,
      idleCompactionWorkflow,
      readPromptResult: opencode.readPromptResult,
      logger,
      formatError,
    });

    yield* Queue.take(eventQueue).pipe(
      Effect.flatMap((event) => eventHandler.handleEvent(event.payload)),
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
        questionRuntime
          .terminateSession(sessionId)
          .pipe(Effect.flatMap((signals) => applyQuestionWorkflowSignals(sessionId, signals))),
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

    const drainQueuedRunRequestsForShutdown = (session: ChannelSession) =>
      Queue.clear(session.queue).pipe(Effect.asVoid);

    const worker = (session: ChannelSession): Effect.Effect<never> =>
      Effect.forever(
        takeQueuedRunBatch(session.queue).pipe(
          Effect.flatMap((requests) =>
            Ref.get(shutdownStartedRef).pipe(
              Effect.flatMap((shutdownStarted) =>
                shutdownStarted ? Effect.void : runExecutor(session, requests),
              ),
            ),
          ),
          Effect.catch((error) =>
            logger.error("channel worker iteration failed", {
              channelId: session.channelId,
              error: formatError(error),
            }),
          ),
        ),
      );

    const getUsableSession = (message: Message, reason: string): FallibleEffect<ChannelSession> =>
      createOrGetSession(message).pipe(
        Effect.flatMap((session) => ensureSessionHealth(session, message, reason)),
      );

    const startShutdown = (): Effect.Effect<boolean> =>
      Ref.modify(shutdownStartedRef, (started): readonly [boolean, boolean] =>
        started ? [false, true] : [true, true],
      );
    const shutdown: ChannelRuntimeShape["shutdown"] = createSessionShutdown({
      startShutdown,
      getState: () => Ref.get(stateRef),
      questionRuntime,
      idleCompactionWorkflow,
      opencode,
      logger,
      infoCards,
      drainQueuedRunRequestsForShutdown,
      interruptSessionWorkers: () => FiberSet.clear(fiberSet),
      shutdownSessions,
      formatError,
    });
    const isShuttingDown: SessionRuntimeShape["isShuttingDown"] = () => Ref.get(shutdownStartedRef);
    const sessionRuntime = makeSessionRuntime({
      getLoaded: (channelId) =>
        getSession(channelId).pipe(Effect.map((session) => session ?? null)),
      getOrRestore: getOrRestoreSession,
      getUsableSession,
      getActiveRunBySessionId,
      routeQuestionInteraction: (interaction) =>
        routeQuestionInteraction(interaction).pipe(Effect.asVoid),
      invalidate: invalidateSession,
      isSessionBusy,
      hasPendingQuestions,
      hasIdleCompaction: (sessionId) => idleCompactionWorkflow.hasActive(sessionId),
      isShuttingDown,
      shutdown,
    });
    const commandLayer = Layer.mergeAll(
      Layer.succeed(AppConfig, config),
      Layer.succeed(IdleCompactionWorkflow, idleCompactionWorkflow),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(OpencodeService, opencode),
      Layer.succeed(SessionRuntime, sessionRuntime),
      Layer.succeed(SessionStore, sessionStore),
      Layer.succeed(Logger, logger),
    );
    const commandHandler = createCommandHandler({
      commandLayer,
    });
    const channelRuntime = {
      submit: (message, invocation): FallibleEffect<void> =>
        isShuttingDown().pipe(
          Effect.flatMap((shutdownStarted) =>
            shutdownStarted
              ? Effect.void
              : Effect.acquireUseRelease(
                  Effect.sync(() => startTypingLoop(message.channel)),
                  () =>
                    Effect.gen(function* () {
                      const session = yield* sessionRuntime.getUsableSession(
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
        isShuttingDown().pipe(
          Effect.flatMap((shutdownStarted) =>
            shutdownStarted
              ? Effect.void
              : interaction.isChatInputCommand()
                ? commandHandler.handleInteraction(interaction)
                : interaction.isButton() ||
                    interaction.isStringSelectMenu() ||
                    interaction.isModalSubmit()
                  ? sessionRuntime.routeQuestionInteraction(interaction)
                  : Effect.void,
          ),
        ),
      shutdown,
    } satisfies ChannelRuntimeShape;

    return Layer.mergeAll(
      Layer.succeed(IdleCompactionWorkflow, idleCompactionWorkflow),
      Layer.succeed(SessionRuntime, sessionRuntime),
      Layer.succeed(ChannelRuntime, channelRuntime),
    );
  }),
);
