import { Chunk, Context, Effect, FiberSet, Layer, Queue, Ref } from "effect";
import { type Interaction, type Message, type SendableChannels } from "discord.js";

import { AppConfig } from "@/config.ts";
import { compactionCardContent } from "@/discord/compaction-card.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { editInfoCard, sendInfoCard, upsertInfoCard } from "@/discord/info-card.ts";
import {
  buildOpencodePrompt,
  promptMessageContext,
  sendChannelProgressUpdate,
  sendFinalResponse,
  startTypingLoop,
} from "@/discord/messages.ts";
import { formatCompactionSummary } from "@/discord/progress.ts";
import { OpencodeEventQueue } from "@/opencode/events.ts";
import type { Invocation } from "@/discord/triggers.ts";
import { OpencodeService } from "@/opencode/service.ts";
import { createCommandRuntime } from "@/sessions/command-runtime.ts";
import { createEventRuntime } from "@/sessions/event-runtime.ts";
import { collectAttachmentMessages } from "@/sessions/message-context.ts";
import { coordinateActiveRunPrompts } from "@/sessions/prompt-coordinator.ts";
import { runProgressWorker } from "@/sessions/progress.ts";
import { createQuestionRuntime } from "@/sessions/question-runtime.ts";
import { enqueueRunRequest } from "@/sessions/request-routing.ts";
import { executeRunBatch } from "@/sessions/run-executor.ts";
import {
  createSessionLifecycle,
  type SessionLifecycleState,
} from "@/sessions/session-lifecycle.ts";
import { type ActiveRun, type ChannelSession, type RunRequest } from "@/sessions/session.ts";
import { defaultChannelSettings } from "@/state/channel-settings.ts";
import { Logger } from "@/util/logging.ts";
import { resolveStatePaths } from "@/state/paths.ts";
import { SessionStore } from "@/state/store.ts";

export type ChannelSessionsShape = {
  submit: (message: Message, invocation: Invocation) => Effect.Effect<void, unknown>;
  getActiveRunBySessionId: (sessionId: string) => Effect.Effect<ActiveRun | null>;
  handleInteraction: (interaction: Interaction) => Effect.Effect<boolean, unknown>;
  shutdown: () => Effect.Effect<void, unknown>;
};

export class ChannelSessions extends Context.Tag("ChannelSessions")<
  ChannelSessions,
  ChannelSessionsShape
>() {}
type FallibleEffect<A> = Effect.Effect<A, unknown>;

const formatError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

type SessionRuntimeState = SessionLifecycleState;

const createSessionRuntimeState = (): SessionRuntimeState => ({
  sessionsByChannelId: new Map(),
  sessionsBySessionId: new Map(),
  activeRunsBySessionId: new Map(),
  gatesByChannelId: new Map(),
  idleCompactionsBySessionId: new Map(),
});

export const ChannelSessionsLive = Layer.scoped(
  ChannelSessions,
  Effect.gen(function* () {
    const logger = yield* Logger;
    const config = yield* AppConfig;
    const opencode = yield* OpencodeService;
    const eventQueue = yield* OpencodeEventQueue;
    const sessionStore = yield* SessionStore;
    const stateRef = yield* Ref.make(createSessionRuntimeState());
    const shutdownStartedRef = yield* Ref.make(false);
    const lateIdleCompactionFinalizersRef = yield* Ref.make(
      new Map<string, { title: string; body: string }>(),
    );
    const fiberSet = yield* FiberSet.make();
    const statePaths = resolveStatePaths(config.stateDir);
    const channelSettingsDefaults = defaultChannelSettings(config);

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
      startWorker: (session) => FiberSet.run(fiberSet, worker(session)).pipe(Effect.asVoid),
      logger,
      sessionInstructions: config.sessionInstructions,
      triggerPhrase: config.triggerPhrase,
      channelSettingsDefaults,
      idleTimeoutMs: config.sessionIdleTimeoutMs,
      sessionsRootDir: statePaths.sessionsRootDir,
    });
    const {
      getActiveRunBySessionId,
      getSessionContext,
      hasIdleCompaction,
      getIdleCompactionCard,
      awaitIdleCompaction,
      getIdleCompactionInterruptRequested,
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

    const finalizeIdleCompactionCard = (sessionId: string, title: string, body: string) =>
      completeIdleCompaction(sessionId).pipe(
        Effect.flatMap((compaction) => {
          if (!compaction) {
            return Effect.void;
          }

          const card = compaction.card;
          if (!card) {
            return Ref.update(lateIdleCompactionFinalizersRef, (current) => {
              const next = new Map(current);
              next.set(sessionId, { title, body });
              return next;
            });
          }

          return Effect.promise(() => editInfoCard(card, title, body)).pipe(
            Effect.catchAll((error) =>
              logger.warn("failed to finalize idle compaction card", {
                sessionId,
                error: formatError(error),
              }),
            ),
            Effect.asVoid,
          );
        }),
      );

    const attachIdleCompactionCard = (sessionId: string, card: Message | null) =>
      setIdleCompactionCard(sessionId, card).pipe(
        Effect.zipRight(
          !card
            ? Effect.void
            : Ref.modify(
                lateIdleCompactionFinalizersRef,
                (
                  current,
                ): readonly [
                  { title: string; body: string } | null,
                  Map<string, { title: string; body: string }>,
                ] => {
                  const pending = current.get(sessionId) ?? null;
                  if (!pending) {
                    return [null, current];
                  }

                  const next = new Map(current);
                  next.delete(sessionId);
                  return [pending, next];
                },
              ).pipe(
                Effect.flatMap((pending) =>
                  pending
                    ? Effect.promise(() => editInfoCard(card, pending.title, pending.body)).pipe(
                        Effect.catchAll((error) =>
                          logger.warn("failed to finalize late idle compaction card", {
                            sessionId,
                            error: formatError(error),
                          }),
                        ),
                        Effect.asVoid,
                      )
                    : Effect.void,
                ),
              ),
        ),
      );

    const updateIdleCompactionCard = (sessionId: string, title: string, body: string) =>
      getIdleCompactionCard(sessionId).pipe(
        Effect.flatMap((card) => {
          if (!card) {
            return Effect.void;
          }

          return Effect.promise(() => editInfoCard(card, title, body)).pipe(
            Effect.catchAll((error) =>
              logger.warn("failed to update idle compaction card", {
                sessionId,
                error: formatError(error),
              }),
            ),
            Effect.asVoid,
          );
        }),
      );

    const sendCompactionSummary = (session: ChannelSession, text: string) => {
      if (!session.channelSettings.showCompactionSummaries) {
        return Effect.void;
      }
      const channel = session.progressChannel;
      const formatted = formatCompactionSummary(text);
      if (!channel) {
        return logger
          .warn("dropping compaction summary without a session progress channel", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
          })
          .pipe(Effect.asVoid);
      }
      if (!formatted) {
        return Effect.void;
      }

      return Effect.promise(() =>
        sendChannelProgressUpdate({
          channel,
          mentionContext: session.progressMentionContext,
          text: formatted,
        }),
      ).pipe(
        Effect.catchAll((error) =>
          logger.warn("failed to send compaction summary", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: formatError(error),
          }),
        ),
        Effect.asVoid,
      );
    };

    const questionRuntime = yield* createQuestionRuntime({
      getSessionContext,
      replyToQuestion: opencode.replyToQuestion,
      rejectQuestion: opencode.rejectQuestion,
      sendQuestionUiFailure,
      logger,
      formatError,
    });

    const eventRuntime = createEventRuntime({
      getSessionContext,
      handleQuestionEvent: questionRuntime.handleEvent,
      finalizeIdleCompactionCard,
      sendCompactionSummary,
      readPromptResult: opencode.readPromptResult,
      logger,
      formatError,
    });

    yield* eventQueue.take().pipe(
      Effect.flatMap((wrapped) => eventRuntime.handleEvent(wrapped.payload)),
      Effect.forever,
      Effect.catchAll((error) =>
        logger.error("opencode event dispatcher failed", {
          error: formatError(error),
        }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.sleep(60_000).pipe(
      Effect.zipRight(closeExpiredSessions()),
      Effect.forever,
      Effect.catchAll((error) =>
        logger.error("idle session sweeper failed", {
          error: formatError(error),
        }),
      ),
      Effect.forkScoped,
    );

    const runExecutor = executeRunBatch({
      runPrompts: ({ channelId, session, activeRun, initialRequests }) =>
        coordinateActiveRunPrompts({
          channelId,
          session,
          activeRun,
          initialRequests,
          awaitIdleCompaction,
          submitPrompt: opencode.submitPrompt,
          logger,
        }),
      runProgressWorker,
      startTyping: (message) => startTypingLoop(message.channel),
      setActiveRun,
      terminateQuestionBatches: questionRuntime.terminateForSession,
      ensureSessionHealthAfterFailure: (session, responseMessage) =>
        ensureSessionHealth(
          session,
          responseMessage,
          "run failed with unhealthy opencode session",
          false,
        ),
      sendRunInterruptedInfo: (message) =>
        Effect.promise(() =>
          sendInfoCard(
            message.channel as SendableChannels,
            "‼️ Run interrupted",
            "OpenCode stopped the active run in this channel.",
          ).then(() => undefined),
        ).pipe(
          Effect.catchAll((error) =>
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
        Queue.take(session.queue).pipe(
          Effect.flatMap((first) =>
            Queue.takeUpTo(session.queue, 64).pipe(
              Effect.flatMap((rest) =>
                runExecutor(session, [first, ...Chunk.toReadonlyArray(rest)]),
              ),
            ),
          ),
          Effect.catchAll((error) =>
            logger.error("channel worker iteration failed", {
              channelId: session.channelId,
              error: formatError(error),
            }),
          ),
        ),
      );

    const commandRuntime = createCommandRuntime({
      getSession: getOrRestoreSession,
      getLiveSession: (channelId) =>
        sessionLifecycle.getSession(channelId).pipe(Effect.map((session) => session ?? null)),
      invalidateSession,
      getChannelSettings: sessionStore.getChannelSettings,
      upsertChannelSettings: sessionStore.upsertChannelSettings,
      channelSettingsDefaults,
      hasIdleCompaction,
      hasPendingQuestions: questionRuntime.hasPendingQuestionsForSession,
      getIdleCompactionCard,
      beginIdleCompaction,
      setIdleCompactionCard: attachIdleCompactionCard,
      setIdleCompactionInterruptRequested,
      getIdleCompactionInterruptRequested,
      updateIdleCompactionCard,
      finalizeIdleCompactionCard,
      isSessionHealthy: opencode.isHealthy,
      compactSession: opencode.compactSession,
      interruptSession: opencode.interruptSession,
      upsertInfoCard,
      logger,
      formatError,
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
                const stoppedCompactionCard = compactionCardContent("stopped");

                yield* questionRuntime.shutdown().pipe(
                  Effect.catchAll((error) =>
                    logger.warn("failed to shut down question runtime", {
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
                        Effect.catchAll((error) =>
                          logger.warn("failed to finalize active run progress on shutdown", {
                            sessionId,
                            error: formatError(error),
                          }),
                        ),
                      );
                    }),
                  { concurrency: "unbounded", discard: true },
                );

                yield* Effect.forEach(
                  idleCompactionIds,
                  (sessionId) =>
                    finalizeIdleCompactionCard(
                      sessionId,
                      stoppedCompactionCard.title,
                      stoppedCompactionCard.body,
                    ).pipe(
                      Effect.catchAll((error) =>
                        logger.warn("failed to finalize idle compaction on shutdown", {
                          sessionId,
                          error: formatError(error),
                        }),
                      ),
                    ),
                  { concurrency: "unbounded", discard: true },
                );

                yield* FiberSet.clear(fiberSet).pipe(
                  Effect.catchAll((error) =>
                    logger.warn("failed to interrupt session workers on shutdown", {
                      error: formatError(error),
                    }),
                  ),
                );
                yield* shutdownSessions().pipe(
                  Effect.catchAll((error) =>
                    logger.warn("failed to shut down sessions", {
                      error: formatError(error),
                    }),
                  ),
                );
                yield* Ref.set(lateIdleCompactionFinalizersRef, new Map());
              }),
              true,
            ],
      ).pipe(
        Effect.flatten,
        Effect.catchAll((error) =>
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
        commandRuntime
          .handleInteraction(interaction)
          .pipe(
            Effect.flatMap((handled) =>
              handled ? Effect.succeed(true) : questionRuntime.handleInteraction(interaction),
            ),
          ),
      shutdown,
    } satisfies ChannelSessionsShape;
  }),
);
