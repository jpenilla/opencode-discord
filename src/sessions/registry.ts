import { Chunk, Context, Effect, FiberSet, Layer, Queue, Ref } from "effect"
import { type Interaction, type Message } from "discord.js"

import { AppConfig } from "@/config.ts"
import { formatErrorResponse } from "@/discord/formatting.ts"
import { editInfoCard, sendInfoCard, upsertInfoCard } from "@/discord/info-card.ts"
import {
  buildOpencodePrompt,
  promptMessageContext,
  sendFinalResponse,
  startTypingLoop,
} from "@/discord/messages.ts"
import {
  OpencodeEventQueue,
  getEventSessionId,
  getQuestionAsked,
  getQuestionRejected,
  getQuestionReplied,
} from "@/opencode/events.ts"
import type { Invocation } from "@/discord/triggers.ts"
import { OpencodeService } from "@/opencode/service.ts"
import { createCommandRuntime } from "@/sessions/command-runtime.ts"
import { collectAttachmentMessages } from "@/sessions/message-context.ts"
import { coordinateActiveRunPrompts } from "@/sessions/prompt-coordinator.ts"
import { collectProgressEvents, runProgressWorker } from "@/sessions/progress.ts"
import { createQuestionRuntime } from "@/sessions/question-runtime.ts"
import { enqueueRunRequest } from "@/sessions/request-routing.ts"
import { executeRunBatch } from "@/sessions/run-executor.ts"
import { createSessionLifecycle, type SessionLifecycleState } from "@/sessions/session-lifecycle.ts"
import {
  type ActiveRun,
  type ChannelSession,
  type RunRequest,
} from "@/sessions/session.ts"
import { Logger } from "@/util/logging.ts"

export type ChannelSessionsShape = {
  submit: (message: Message, invocation: Invocation) => Effect.Effect<void, unknown>
  getActiveRunBySessionId: (sessionId: string) => Effect.Effect<ActiveRun | null>
  handleInteraction: (interaction: Interaction) => Effect.Effect<boolean, unknown>
}

export class ChannelSessions extends Context.Tag("ChannelSessions")<ChannelSessions, ChannelSessionsShape>() {}
type FallibleEffect<A> = Effect.Effect<A, unknown>

const formatError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

type SessionRuntimeState = SessionLifecycleState

const createSessionRuntimeState = (): SessionRuntimeState => ({
  sessionsByChannelId: new Map(),
  sessionsBySessionId: new Map(),
  activeRunsBySessionId: new Map(),
  gatesByChannelId: new Map(),
  idleCompactionCardsBySessionId: new Map(),
})

export const ChannelSessionsLive = Layer.scoped(
  ChannelSessions,
  Effect.gen(function* () {
    const logger = yield* Logger
    const config = yield* AppConfig
    const opencode = yield* OpencodeService
    const eventQueue = yield* OpencodeEventQueue
    const stateRef = yield* Ref.make(createSessionRuntimeState())
    const fiberSet = yield* FiberSet.make()

    const sendErrorReply = (message: Message, title: string, error: unknown) =>
      Effect.promise(() =>
        message.reply({
          content: formatErrorResponse(title, formatError(error)),
          allowedMentions: { repliedUser: false, parse: [] },
        }),
      )

    const sendRunFailure = (message: Message, error: unknown) =>
      sendErrorReply(message, "## ❌ Opencode failed", error)

    const sendQuestionUiFailure = (message: Message, error: unknown) =>
      sendErrorReply(message, "## ❌ Failed to show questions", error)

    const sessionLifecycle = createSessionLifecycle({
      stateRef,
      createOpencodeSession: opencode.createSession,
      isSessionHealthy: opencode.isHealthy,
      startWorker: (session) => FiberSet.run(fiberSet, worker(session)).pipe(Effect.asVoid),
      logger,
      sessionInstructions: config.sessionInstructions,
      triggerPhrase: config.triggerPhrase,
    })
    const {
      getSession: getChannelSession,
      getActiveRunBySessionId,
      getSessionContext,
      getIdleCompactionCard,
      setActiveRun,
      setIdleCompactionCard,
      createOrGetSession,
      ensureSessionHealth,
      shutdownSessions,
    } = sessionLifecycle

    const getSession = (channelId: string) =>
      getChannelSession(channelId).pipe(Effect.map((session) => session ?? null))

    const updateIdleCompactionCard = (sessionId: string, title: string, body: string) =>
      getIdleCompactionCard(sessionId).pipe(
        Effect.flatMap((card) => {
          if (!card) {
            return Effect.void
          }

          return Effect.promise(() => editInfoCard(card, title, body)).pipe(
            Effect.catchAll((error) =>
              logger.warn("failed to update idle compaction card", {
                sessionId,
                error: formatError(error),
              }).pipe(Effect.zipRight(setIdleCompactionCard(sessionId, null))),
            ),
            Effect.asVoid,
          )
        }),
      )

    const questionRuntime = yield* createQuestionRuntime({
      getSessionContext,
      replyToQuestion: opencode.replyToQuestion,
      rejectQuestion: opencode.rejectQuestion,
      sendQuestionUiFailure,
      logger,
      formatError,
    })

    yield* eventQueue.take().pipe(
      Effect.flatMap((wrapped) => {
        const sessionId = getEventSessionId(wrapped.payload)
        if (!sessionId) {
          return Effect.void
        }

        return getSessionContext(sessionId).pipe(
          Effect.flatMap((context) => {
            if (!context) {
              return Effect.void
            }

            const { session, activeRun } = context
            const progressEvents = collectProgressEvents(wrapped.payload)
            const questionAsked = getQuestionAsked(wrapped.payload)
            const questionReplied = getQuestionReplied(wrapped.payload)
            const questionRejected = getQuestionRejected(wrapped.payload)

            return Effect.gen(function* () {
              if (questionAsked) {
                yield* questionRuntime.handleEvent({
                  type: "asked",
                  sessionId,
                  request: questionAsked,
                })
              }
              if (questionReplied) {
                yield* questionRuntime.handleEvent({
                  type: "replied",
                  sessionId,
                  requestId: questionReplied.requestID,
                  answers: questionReplied.answers,
                })
              }
              if (questionRejected) {
                yield* questionRuntime.handleEvent({
                  type: "rejected",
                  sessionId,
                  requestId: questionRejected.requestID,
                })
              }

              if (activeRun) {
                yield* Effect.forEach(progressEvents, (progressEvent) =>
                  Queue.offer(activeRun.progressQueue, progressEvent).pipe(Effect.asVoid),
                ).pipe(Effect.asVoid)
              } else if (progressEvents.some((event) => event.type === "session-compacted")) {
                yield* updateIdleCompactionCard(
                  sessionId,
                  "🗜️ Session compacted",
                  "OpenCode summarized earlier context for this session.",
                )
              }
            })
          }),
        )
      }),
      Effect.forever,
      Effect.catchAll((error) =>
        logger.error("opencode event dispatcher failed", {
          error: formatError(error),
        }),
      ),
      Effect.forkScoped,
    )

    const runExecutor = executeRunBatch({
      runPrompts: ({ channelId, session, activeRun, initialRequests }) =>
        coordinateActiveRunPrompts({
          channelId,
          session,
          activeRun,
          initialRequests,
          prompt: opencode.prompt,
          logger,
        }),
      runProgressWorker,
      startTyping: (message) => startTypingLoop(message.channel),
      setActiveRun,
      expireQuestionBatches: questionRuntime.expireForSession,
      ensureSessionHealthAfterFailure: (session, responseMessage) =>
        ensureSessionHealth(session, responseMessage, "run failed with unhealthy opencode session", false),
      sendFinalResponse: (message, text) =>
        Effect.promise(() => sendFinalResponse({ message, text })),
      sendRunFailure,
      sendQuestionUiFailure,
      logger,
      formatError,
    })

    const worker = (session: ChannelSession): Effect.Effect<never> =>
      Effect.forever(
        Queue.take(session.queue).pipe(
          Effect.flatMap((first) =>
            Queue.takeUpTo(session.queue, 64).pipe(
              Effect.flatMap((rest) => runExecutor(session, [first, ...Chunk.toReadonlyArray(rest)])),
            ),
          ),
          Effect.catchAll((error) =>
            logger.error("channel worker iteration failed", {
              channelId: session.channelId,
              error: formatError(error),
            }),
          ),
        ),
      )

    const commandRuntime = createCommandRuntime({
      getSession,
      getIdleCompactionCard,
      setIdleCompactionCard,
      updateIdleCompactionCard,
      isSessionHealthy: opencode.isHealthy,
      compactSession: opencode.compactSession,
      interruptSession: opencode.interruptSession,
      upsertInfoCard,
      editInfoCard,
      sendInfoCard,
      logger,
      formatError,
    })

    const getUsableSession = (message: Message, reason: string): FallibleEffect<ChannelSession> =>
      createOrGetSession(message).pipe(
        Effect.flatMap((session) => ensureSessionHealth(session, message, reason)),
      )

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* shutdownSessions().pipe(Effect.ignore)
        yield* FiberSet.clear(fiberSet)
      }),
    )

    return {
      submit: (message, invocation): FallibleEffect<void> =>
        Effect.gen(function* () {
          const session = yield* getUsableSession(message, "health probe failed before queueing run")
          const attachmentMessages = yield* collectAttachmentMessages(message)
          const referencedMessage = attachmentMessages.find((candidate) => candidate.id !== message.id) ?? null
          const prompt = buildOpencodePrompt({
            message: promptMessageContext(message, invocation.prompt),
            referencedMessage: referencedMessage ? promptMessageContext(referencedMessage) : undefined,
          })

          const request = {
            message,
            prompt,
            attachmentMessages,
          } satisfies RunRequest

          const destination = yield* enqueueRunRequest(session, request)
          if (destination === "follow-up") {
            yield* logger.info("queued follow-up on active run", {
              channelId: message.channelId,
              sessionId: session.opencode.sessionId,
              author: message.author.tag,
            })
          } else {
            yield* logger.info("queued run", {
              channelId: message.channelId,
              sessionId: session.opencode.sessionId,
              author: message.author.tag,
            })
          }
        }),
      getActiveRunBySessionId,
      handleInteraction: (interaction) =>
        commandRuntime.handleInteraction(interaction).pipe(
          Effect.flatMap((handled) => handled ? Effect.succeed(true) : questionRuntime.handleInteraction(interaction)),
        ),
    } satisfies ChannelSessionsShape
  }),
)
