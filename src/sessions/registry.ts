import { Chunk, Context, Effect, FiberSet, Layer, Queue, Ref } from "effect"
import { ChannelType, MessageFlags, type Interaction, type Message, type SendableChannels } from "discord.js"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"

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
  buildQuestionAnswers,
  buildQuestionModal,
  clearQuestionDraft,
  createQuestionMessageCreate,
  createQuestionMessageEdit,
  parseQuestionActionId,
  QUESTION_OPTIONS_PER_PAGE,
  questionOptionPageCount,
  questionDrafts,
  questionInteractionReply,
  readQuestionModalValue,
  setQuestionCustomAnswer,
  setQuestionOptionSelection,
  type QuestionBatchStatus,
  type QuestionDraft,
} from "@/discord/question-card.ts"
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
import { expireQuestionBatch, setQuestionBatchStatus } from "@/sessions/question-batch-state.ts"
import { rejectQuestionBatch, submitQuestionBatch } from "@/sessions/question-submission.ts"
import { enqueueRunRequest } from "@/sessions/request-routing.ts"
import { executeRunBatch } from "@/sessions/run-executor.ts"
import { admitRequestBatchToActiveRun, type NonEmptyRunRequestBatch } from "@/sessions/run-batch.ts"
import { createSessionLifecycle, type SessionLifecycleState } from "@/sessions/session-lifecycle.ts"
import {
  type ActiveRun,
  type ChannelSession,
  questionUiFailureOutcome,
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

type PendingQuestionBatch = {
  request: QuestionRequest
  session: ChannelSession
  ownerId: string
  message: Message | null
  page: number
  optionPages: number[]
  drafts: QuestionDraft[]
  status: QuestionBatchStatus | "expired"
  resolvedAnswers?: Array<QuestionAnswer>
}
type SessionRuntimeState = SessionLifecycleState & {
  questionBatchesByRequestId: Map<string, PendingQuestionBatch>
}

const createSessionRuntimeState = (): SessionRuntimeState => ({
  sessionsByChannelId: new Map(),
  sessionsBySessionId: new Map(),
  activeRunsBySessionId: new Map(),
  gatesByChannelId: new Map(),
  idleCompactionCardsBySessionId: new Map(),
  questionBatchesByRequestId: new Map<string, PendingQuestionBatch>(),
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

    const questionBatchView = (batch: PendingQuestionBatch) => ({
      request: batch.request,
      page: batch.page,
      optionPages: batch.optionPages,
      drafts: batch.drafts,
      status: batch.status,
      resolvedAnswers: batch.resolvedAnswers,
    })

    const hasPendingQuestionsForSession = (state: SessionRuntimeState, sessionId: string) =>
      [...state.questionBatchesByRequestId.values()].some(
        (batch) =>
          batch.session.opencode.sessionId === sessionId &&
          (batch.status === "active" || batch.status === "submitting"),
      )

    const syncTypingForSession = (sessionId: string) =>
      Ref.get(stateRef).pipe(
        Effect.flatMap((state) => {
          const activeRun = state.activeRunsBySessionId.get(sessionId)
          if (!activeRun) {
            return Effect.void
          }

          if (hasPendingQuestionsForSession(state, sessionId)) {
            return Effect.promise(() => activeRun.typing.pause()).pipe(
              Effect.timeoutOption("1 second"),
              Effect.flatMap((result) =>
                result._tag === "Some"
                  ? Effect.void
                  : logger.warn("typing pause timed out while question prompt was active", {
                      channelId: activeRun.discordMessage.channelId,
                      sessionId,
                    }),
              ),
            )
          }

          return Effect.sync(() => {
            activeRun.typing.resume()
          })
        }),
      )

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
      getIdleCompactionCard,
      setActiveRun,
      setIdleCompactionCard,
      createOrGetSession,
      ensureSessionHealth,
      shutdownSessions,
    } = sessionLifecycle

    const getSession = getChannelSession
    const getQuestionBatch = (requestId: string) =>
      Ref.get(stateRef).pipe(Effect.map((state) => state.questionBatchesByRequestId.get(requestId) ?? null))
    const putQuestionBatch = (batch: PendingQuestionBatch) =>
      Ref.update(stateRef, (current) => {
        const questionBatchesByRequestId = new Map(current.questionBatchesByRequestId)
        questionBatchesByRequestId.set(batch.request.id, batch)
        return {
          ...current,
          questionBatchesByRequestId,
        }
      })
    const updateQuestionBatch = (requestId: string, update: (batch: PendingQuestionBatch) => PendingQuestionBatch | null) =>
      Ref.modify(stateRef, (current): readonly [PendingQuestionBatch | null, SessionRuntimeState] => {
        const existing = current.questionBatchesByRequestId.get(requestId)
        if (!existing) {
          return [null, current]
        }

        const nextBatch = update(existing)
        const questionBatchesByRequestId = new Map(current.questionBatchesByRequestId)
        if (nextBatch) {
          questionBatchesByRequestId.set(requestId, nextBatch)
        } else {
          questionBatchesByRequestId.delete(requestId)
        }

        return [
          nextBatch,
          {
            ...current,
            questionBatchesByRequestId,
          },
        ]
      })
    const removeQuestionBatch = (requestId: string) =>
      Ref.modify(stateRef, (current): readonly [PendingQuestionBatch | null, SessionRuntimeState] => {
        const existing = current.questionBatchesByRequestId.get(requestId) ?? null
        if (!existing) {
          return [null, current]
        }

        const questionBatchesByRequestId = new Map(current.questionBatchesByRequestId)
        questionBatchesByRequestId.delete(requestId)

        return [
          existing,
          {
            ...current,
            questionBatchesByRequestId,
          },
        ]
      })

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

    const editQuestionMessage = (batch: PendingQuestionBatch) => {
      if (!batch.message) {
        return Effect.void
      }

      return Effect.promise(() => batch.message!.edit(createQuestionMessageEdit(questionBatchView(batch)))).pipe(
        Effect.asVoid,
      )
    }

    const handleQuestionAsked = (
      session: ChannelSession,
      activeRun: ActiveRun,
      request: QuestionRequest,
    ): FallibleEffect<void> =>
      Effect.gen(function* () {
        const existing = yield* getQuestionBatch(request.id)
        if (existing) {
          return
        }

        const batch: PendingQuestionBatch = {
          request,
          session,
          ownerId: activeRun.discordMessage.author.id,
          message: null,
          page: 0,
          optionPages: request.questions.map(() => 0),
          drafts: questionDrafts(request),
          status: "active",
        }

        try {
          const questionMessage = yield* Effect.tryPromise({
            try: () =>
              activeRun.discordMessage.reply({
                ...createQuestionMessageCreate(questionBatchView(batch)),
                allowedMentions: { repliedUser: true, parse: ["users", "roles", "everyone"] },
              }),
            catch: (error) => error,
          }).pipe(
            Effect.timeoutFail({
              duration: "5 seconds",
              onTimeout: () => new Error("Timed out sending question batch to Discord"),
            }),
          )

          yield* putQuestionBatch({
            ...batch,
            message: questionMessage,
          })
          yield* syncTypingForSession(session.opencode.sessionId)
        } catch (error) {
          const questionUiFailure = formatError(error)
          activeRun.questionOutcome = questionUiFailureOutcome(questionUiFailure)
          yield* logger.error("failed to post question batch", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            requestId: request.id,
            error: formatError(error),
          })

          const rejectResult = yield* opencode.rejectQuestion(session.opencode, request.id).pipe(
            Effect.either,
          )
          if (rejectResult._tag === "Left") {
            yield* logger.error("failed to reject question batch after UI failure", {
                channelId: session.channelId,
                sessionId: session.opencode.sessionId,
                requestId: request.id,
                error: formatError(rejectResult.left),
              })

            yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore)
            const failureReply = yield* sendQuestionUiFailure(activeRun.discordMessage, questionUiFailure).pipe(
              Effect.either,
            )
            if (failureReply._tag === "Right") {
              activeRun.questionOutcome = questionUiFailureOutcome(questionUiFailure, true)
            } else {
              yield* logger.error("failed to send question UI failure message", {
                channelId: session.channelId,
                sessionId: session.opencode.sessionId,
                requestId: request.id,
                error: formatError(failureReply.left),
              })
            }
            return
          }

          yield* syncTypingForSession(session.opencode.sessionId)
        }
      })

    const finalizeQuestionBatch = (
      requestId: string,
      status: "answered" | "rejected",
      resolvedAnswers?: ReadonlyArray<QuestionAnswer>,
    ): FallibleEffect<void> =>
      Effect.gen(function* () {
        const batch = yield* updateQuestionBatch(requestId, (current) =>
          setQuestionBatchStatus(current, status, resolvedAnswers),
        )
        if (!batch) {
          return
        }

        yield* editQuestionMessage(batch).pipe(
          Effect.catchAll((error) =>
            logger.warn("failed to edit finalized question batch", {
              channelId: batch.session.channelId,
              sessionId: batch.session.opencode.sessionId,
              requestId,
              error: formatError(error),
            }),
          ),
        )
        yield* removeQuestionBatch(requestId)
        yield* syncTypingForSession(batch.session.opencode.sessionId)
      })

    const expireQuestionBatchesForSession = (sessionId: string): FallibleEffect<void> =>
      Effect.gen(function* () {
        const expired = yield* Ref.modify(stateRef, (current): readonly [PendingQuestionBatch[], SessionRuntimeState] => {
          const stale = [...current.questionBatchesByRequestId.values()].filter(
            (batch) =>
              batch.session.opencode.sessionId === sessionId &&
              (batch.status === "active" || batch.status === "submitting"),
          )
          if (stale.length === 0) {
            return [[], current]
          }

          const questionBatchesByRequestId = new Map(current.questionBatchesByRequestId)
          for (const batch of stale) {
            questionBatchesByRequestId.delete(batch.request.id)
          }

          return [
            stale.map((batch) => expireQuestionBatch(batch)),
            {
              ...current,
              questionBatchesByRequestId,
            },
          ]
        })

        yield* Effect.forEach(
          expired,
          (batch) =>
            editQuestionMessage(batch).pipe(
              Effect.catchAll((error) =>
                logger.warn("failed to expire question batch message", {
                  channelId: batch.session.channelId,
                  sessionId: batch.session.opencode.sessionId,
                  requestId: batch.request.id,
                  error: formatError(error),
                }),
              ),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.asVoid)
      })

    yield* eventQueue.take().pipe(
      Effect.flatMap((wrapped) => {
        const sessionId = getEventSessionId(wrapped.payload)
        if (!sessionId) {
          return Effect.void
        }

        return Ref.get(stateRef).pipe(
          Effect.flatMap((state) => {
            const session = state.sessionsBySessionId.get(sessionId)
            if (!session) {
              return Effect.void
            }

            const activeRun = state.activeRunsBySessionId.get(sessionId)
            const progressEvents = collectProgressEvents(wrapped.payload)
            const questionAsked = getQuestionAsked(wrapped.payload)
            const questionReplied = getQuestionReplied(wrapped.payload)
            const questionRejected = getQuestionRejected(wrapped.payload)

            return Effect.gen(function* () {
              if (questionAsked && activeRun) {
                yield* handleQuestionAsked(session, activeRun, questionAsked)
              }
              if (questionReplied) {
                yield* finalizeQuestionBatch(questionReplied.requestID, "answered", questionReplied.answers)
              }
              if (questionRejected) {
                yield* finalizeQuestionBatch(questionRejected.requestID, "rejected")
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
      expireQuestionBatches: expireQuestionBatchesForSession,
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

    const replyToQuestionInteraction = (interaction: Interaction, message: string) => {
      if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) {
        return Effect.void
      }
      if (interaction.replied || interaction.deferred) {
        return Effect.void
      }
      return Effect.promise(() => interaction.reply(questionInteractionReply(message))).pipe(Effect.ignore)
    }

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

    const persistQuestionBatch = (
      requestId: string,
      update: (batch: PendingQuestionBatch) => PendingQuestionBatch | null,
    ): FallibleEffect<PendingQuestionBatch | null> => updateQuestionBatch(requestId, update)

    const questionSubmissionRuntime = {
      persistBatch: persistQuestionBatch,
      updateInteraction: (interaction: Interaction, batch: PendingQuestionBatch) => {
        if (!interaction.isButton()) {
          return Effect.void
        }
        return Effect.promise(() => interaction.update(createQuestionMessageEdit(questionBatchView(batch))))
      },
      editBatch: editQuestionMessage,
      finalizeBatch: finalizeQuestionBatch,
      replyExpired: (interaction: Interaction) =>
        replyToQuestionInteraction(interaction, "This question prompt has expired."),
      followUpFailure: (interaction: Interaction, message: string) => {
        if (!interaction.isButton()) {
          return Effect.void
        }
        return Effect.promise(() => interaction.followUp(questionInteractionReply(message)))
      },
      submitToOpencode: opencode.replyToQuestion,
      rejectInOpencode: opencode.rejectQuestion,
      formatError,
    } as const

    const currentQuestionDraft = (batch: PendingQuestionBatch, questionIndex: number) =>
      batch.drafts[questionIndex] ?? clearQuestionDraft()

    const applyQuestionUpdate = (
      interaction: Interaction,
      requestId: string,
      update: (batch: PendingQuestionBatch) => PendingQuestionBatch | null,
    ): FallibleEffect<boolean> =>
      Effect.gen(function* () {
        if (!interaction.isButton() && !interaction.isStringSelectMenu()) {
          return false
        }

        const batch = yield* persistQuestionBatch(requestId, update)
        if (!batch) {
          yield* replyToQuestionInteraction(interaction, "This question prompt is no longer active.")
          return true
        }

        yield* Effect.promise(() => interaction.update(createQuestionMessageEdit(questionBatchView(batch))))
        return true
      })

    const handleQuestionInteraction = (interaction: Interaction): FallibleEffect<boolean> =>
      Effect.gen(function* () {
        if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) {
          return false
        }

        const action = parseQuestionActionId(interaction.customId)
        if (!action) {
          return false
        }

        const batch = yield* getQuestionBatch(action.requestID)
        if (!batch) {
          yield* replyToQuestionInteraction(interaction, "This question prompt has expired.")
          return true
        }

        if (interaction.user.id !== batch.ownerId) {
          yield* replyToQuestionInteraction(interaction, "Only the user who started this run can answer these questions.")
          return true
        }

        if ((interaction.isButton() || interaction.isStringSelectMenu()) && batch.message && interaction.message.id !== batch.message.id) {
          yield* replyToQuestionInteraction(interaction, "This question prompt has been replaced.")
          return true
        }

        if (batch.status !== "active") {
          yield* replyToQuestionInteraction(interaction, "This question prompt is already being finalized.")
          return true
        }

        switch (action.kind) {
          case "question-prev":
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => ({
              ...current,
              page: Math.max(0, current.page - 1),
            }))
          case "question-next":
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => ({
              ...current,
              page: Math.min(current.request.questions.length - 1, current.page + 1),
            }))
          case "option-prev":
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => {
              const optionPages = [...current.optionPages]
              optionPages[action.questionIndex] = Math.max(0, (optionPages[action.questionIndex] ?? 0) - 1)
              return {
                ...current,
                page: action.questionIndex,
                optionPages,
              }
            })
          case "option-next":
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => {
              const question = current.request.questions[action.questionIndex]
              if (!question) {
                return current
              }
              const maxOptionPage = Math.max(0, questionOptionPageCount(question) - 1)
              const optionPages = [...current.optionPages]
              optionPages[action.questionIndex] = Math.min(maxOptionPage, (optionPages[action.questionIndex] ?? 0) + 1)
              return {
                ...current,
                page: action.questionIndex,
                optionPages,
              }
            })
          case "clear":
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => {
              const drafts = [...current.drafts]
              drafts[action.questionIndex] = clearQuestionDraft()
              return {
                ...current,
                page: action.questionIndex,
                drafts,
              }
            })
          case "select":
            if (!interaction.isStringSelectMenu()) {
              return false
            }
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => {
              const question = current.request.questions[action.questionIndex]
              if (!question) {
                return current
              }

              const page = current.optionPages[action.questionIndex] ?? 0
              const visibleOptions = question.options
                .slice(
                  page * QUESTION_OPTIONS_PER_PAGE,
                  page * QUESTION_OPTIONS_PER_PAGE + QUESTION_OPTIONS_PER_PAGE,
                )
                .map((option) => option.label)
              const drafts = [...current.drafts]
              drafts[action.questionIndex] = setQuestionOptionSelection({
                question,
                draft: currentQuestionDraft(current, action.questionIndex),
                visibleOptions,
                selectedOptions: interaction.values,
              })
              return {
                ...current,
                page: action.questionIndex,
                drafts,
              }
            })
          case "custom":
            if (!interaction.isButton()) {
              return false
            }

            {
              const question = batch.request.questions[action.questionIndex]
              if (!question || question.custom === false) {
                yield* replyToQuestionInteraction(interaction, "This question does not allow a custom answer.")
                return true
              }

              yield* Effect.promise(() =>
                interaction.showModal(
                  buildQuestionModal({
                    requestID: action.requestID,
                    questionIndex: action.questionIndex,
                    question,
                    draft: currentQuestionDraft(batch, action.questionIndex),
                  }),
                ),
              )
              return true
            }
          case "modal":
            if (!interaction.isModalSubmit()) {
              return false
            }

            {
              const question = batch.request.questions[action.questionIndex]
              if (!question || question.custom === false) {
                yield* replyToQuestionInteraction(interaction, "This question does not allow a custom answer.")
                return true
              }

              const customAnswer = readQuestionModalValue(interaction)
              if (!customAnswer) {
                yield* Effect.promise(() =>
                  interaction.reply(questionInteractionReply("Custom answer cannot be empty.")),
                ).pipe(Effect.ignore)
                return true
              }

              const updated = yield* persistQuestionBatch(action.requestID, (current) => {
                const drafts = [...current.drafts]
                drafts[action.questionIndex] = setQuestionCustomAnswer(
                  question,
                  currentQuestionDraft(current, action.questionIndex),
                  customAnswer,
                )
                return {
                  ...current,
                  page: action.questionIndex,
                  drafts,
                }
              })
              if (!updated) {
                yield* replyToQuestionInteraction(interaction, "This question prompt has expired.")
                return true
              }

              yield* editQuestionMessage(updated).pipe(
                Effect.catchAll((error) =>
                  logger.warn("failed to edit question batch after modal submit", {
                    channelId: updated.session.channelId,
                    sessionId: updated.session.opencode.sessionId,
                    requestId: updated.request.id,
                    error: formatError(error),
                  }),
                ),
              )
              yield* Effect.promise(() => interaction.deferUpdate()).pipe(Effect.ignore)
              return true
            }
          case "submit":
            if (!interaction.isButton()) {
              return false
            }

            return yield* submitQuestionBatch(questionSubmissionRuntime)({
              interaction,
              requestId: action.requestID,
              answers: buildQuestionAnswers(batch.request, batch.drafts),
            })
          case "reject":
            if (!interaction.isButton()) {
              return false
            }

            return yield* rejectQuestionBatch(questionSubmissionRuntime)({
              interaction,
              requestId: action.requestID,
            })
        }
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
          Effect.flatMap((handled) => handled ? Effect.succeed(true) : handleQuestionInteraction(interaction)),
        ),
    } satisfies ChannelSessionsShape
  }),
)
