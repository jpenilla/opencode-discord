import { Chunk, Context, Effect, FiberSet, Layer, Queue, Ref } from "effect"
import { ChannelType, MessageFlags, type Interaction, type Message, type SendableChannels } from "discord.js"

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
import {
  beginInterruptRequest,
  decideCompactAfterHealthCheck,
  decideCompactEntry,
  decideInterruptEntry,
} from "@/sessions/command-lifecycle.ts"
import { collectAttachmentMessages } from "@/sessions/message-context.ts"
import { coordinateActiveRunPrompts } from "@/sessions/prompt-coordinator.ts"
import { collectProgressEvents, runProgressWorker } from "@/sessions/progress.ts"
import { createQuestionRuntime } from "@/sessions/question-runtime.ts"
import { enqueueRunRequest } from "@/sessions/request-routing.ts"
import { executeRunBatch } from "@/sessions/run-executor.ts"
import { admitRequestBatchToActiveRun, type NonEmptyRunRequestBatch } from "@/sessions/run-batch.ts"
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

    const getSession = getChannelSession

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

    const getUsableSession = (message: Message, reason: string): FallibleEffect<ChannelSession> =>
      createOrGetSession(message).pipe(
        Effect.flatMap((session) => ensureSessionHealth(session, message, reason)),
      )

    const replyToCommandInteraction = (interaction: Interaction, message: string) => {
      if (!interaction.isChatInputCommand()) {
        return Effect.void
      }
      if (interaction.replied || interaction.deferred) {
        return Effect.void
      }
      return Effect.promise(() =>
        interaction.reply({
          content: message,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        }),
      ).pipe(Effect.ignore)
    }

    const deferCommandInteraction = (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) {
        return Effect.void
      }
      if (interaction.replied || interaction.deferred) {
        return Effect.void
      }
      return Effect.promise(() => interaction.deferReply({ flags: MessageFlags.Ephemeral })).pipe(Effect.ignore)
    }

    const editCommandInteraction = (interaction: Interaction, message: string) => {
      if (!interaction.isChatInputCommand()) {
        return Effect.void
      }
      if (!interaction.replied && !interaction.deferred) {
        return replyToCommandInteraction(interaction, message)
      }
      return Effect.promise(() =>
        interaction.editReply({
          content: message,
          allowedMentions: { parse: [] },
        }),
      ).pipe(Effect.ignore)
    }

    const handleCommandInteraction = (interaction: Interaction): FallibleEffect<boolean> =>
      Effect.gen(function* () {
        if (!interaction.isChatInputCommand()) {
          return false
        }

        if (interaction.commandName !== "compact" && interaction.commandName !== "interrupt") {
          return false
        }

        const inGuildTextChannel = interaction.inGuild() && interaction.channel?.type === ChannelType.GuildText
        const session = inGuildTextChannel ? yield* getSession(interaction.channelId) : null

        if (interaction.commandName === "compact") {
          const compactEntry = decideCompactEntry({
            inGuildTextChannel,
            hasSession: !!session,
            hasActiveRun: !!session?.activeRun,
          })
          if (compactEntry.type === "reject") {
            yield* replyToCommandInteraction(interaction, compactEntry.message)
            return true
          }

          yield* deferCommandInteraction(interaction)

          const compactHealthDecision = decideCompactAfterHealthCheck(yield* opencode.isHealthy(session!.opencode))
          if (compactHealthDecision.type === "reject-after-defer") {
            yield* editCommandInteraction(interaction, compactHealthDecision.message)
            return true
          }

          const channel = interaction.channel as SendableChannels
          const existingCard = yield* getIdleCompactionCard(session!.opencode.sessionId)
          const compactionCard = yield* Effect.promise(() =>
            upsertInfoCard({
              channel,
              existingCard,
              title: "🗜️ Compacting session",
              body: "OpenCode is summarizing earlier context for this session.",
            }),
          ).pipe(
            Effect.tap((card) => setIdleCompactionCard(session!.opencode.sessionId, card)),
            Effect.catchAll((error) =>
              logger.warn("failed to post idle compaction card", {
                channelId: session!.channelId,
                sessionId: session!.opencode.sessionId,
                error: formatError(error),
              }).pipe(Effect.zipRight(setIdleCompactionCard(session!.opencode.sessionId, null)), Effect.as(null)),
            ),
          )

          yield* opencode.compactSession(session!.opencode).pipe(
            Effect.tap(() =>
              updateIdleCompactionCard(
                session!.opencode.sessionId,
                "🗜️ Session compacted",
                "OpenCode summarized earlier context for this session.",
              ).pipe(Effect.zipRight(setIdleCompactionCard(session!.opencode.sessionId, null))),
            ),
            Effect.tapError((error) =>
              logger.error("failed to compact session", {
                channelId: session!.channelId,
                sessionId: session!.opencode.sessionId,
                error: formatError(error),
              }),
            ),
            Effect.catchAll((error) =>
              compactionCard
                ? Effect.promise(() =>
                    editInfoCard(compactionCard, "❌ Session compaction failed", `OpenCode could not compact this session.\n\n${formatError(error)}`),
                  ).pipe(Effect.ignore, Effect.zipRight(setIdleCompactionCard(session!.opencode.sessionId, null)))
                : Effect.void,
            ),
            Effect.forkDaemon,
          )

          yield* editCommandInteraction(interaction, "Started session compaction. I'll post updates in this channel.")
          return true
        }

        const interruptEntry = decideInterruptEntry({
          inGuildTextChannel,
          hasSession: !!session,
          hasActiveRun: !!session?.activeRun,
        })
        if (interruptEntry.type === "reject") {
          yield* replyToCommandInteraction(interaction, interruptEntry.message)
          return true
        }

        yield* deferCommandInteraction(interaction)

        const activeRun = session!.activeRun!
        const rollbackInterruptRequest = beginInterruptRequest(activeRun)
        const interruptResult = yield* opencode.interruptSession(session!.opencode).pipe(Effect.either)
        if (interruptResult._tag === "Left") {
          rollbackInterruptRequest()
          yield* editCommandInteraction(
            interaction,
            formatErrorResponse("## ❌ Failed to interrupt run", formatError(interruptResult.left)),
          )
          return true
        }

        yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore)
        yield* Effect.promise(async () => {
          await sendInfoCard(
            interaction.channel as SendableChannels,
            "🛑 Run interrupted",
            "OpenCode stopped the active run in this channel.",
          )
        }).pipe(
          Effect.catchAll((error) =>
            logger.warn("failed to post interrupt info card", {
              channelId: session!.channelId,
              sessionId: session!.opencode.sessionId,
              error: formatError(error),
            }),
          ),
          Effect.ignore,
        )
        yield* editCommandInteraction(interaction, "Interrupted the active OpenCode run.")
        return true
      })

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
        handleCommandInteraction(interaction).pipe(
          Effect.flatMap((handled) => handled ? Effect.succeed(true) : questionRuntime.handleInteraction(interaction)),
        ),
    } satisfies ChannelSessionsShape
  }),
)
