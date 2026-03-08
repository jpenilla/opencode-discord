import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import { Chunk, Context, Deferred, Effect, Fiber, FiberSet, Layer, Queue, Ref } from "effect"
import type { Interaction, Message } from "discord.js"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"

import { AppConfig } from "@/config.ts"
import { formatErrorResponse } from "@/discord/formatting.ts"
import {
  buildBatchedOpencodePrompt,
  buildOpencodePrompt,
  buildQueuedFollowUpPrompt,
  sendFinalResponse,
  startTypingLoop,
  summarizeAttachments,
  summarizeEmbeds,
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
import { collectProgressEvents, runProgressWorker } from "@/sessions/progress.ts"
import type { ActiveRun, ChannelSession, RunProgressEvent, RunRequest } from "@/sessions/session.ts"
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

type SessionGate = Deferred.Deferred<ChannelSession, unknown>
type SessionGateDecision = {
  gate: SessionGate
  owner: boolean
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
type SessionRuntimeState = {
  sessionsByChannelId: Map<string, ChannelSession>
  sessionsBySessionId: Map<string, ChannelSession>
  activeRunsBySessionId: Map<string, ActiveRun>
  gatesByChannelId: Map<string, SessionGate>
  questionBatchesByRequestId: Map<string, PendingQuestionBatch>
}
const sessionTitle = (channelId: string) => `Discord #${channelId}`
const createSessionRuntimeState = (): SessionRuntimeState => ({
  sessionsByChannelId: new Map<string, ChannelSession>(),
  sessionsBySessionId: new Map<string, ChannelSession>(),
  activeRunsBySessionId: new Map<string, ActiveRun>(),
  gatesByChannelId: new Map<string, SessionGate>(),
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

    const getSession = (channelId: string) =>
      Ref.get(stateRef).pipe(Effect.map((state) => state.sessionsByChannelId.get(channelId)))
    const getActiveRunBySessionId = (sessionId: string) =>
      Ref.get(stateRef).pipe(Effect.map((state) => state.activeRunsBySessionId.get(sessionId) ?? null))
    const getQuestionBatch = (requestId: string) =>
      Ref.get(stateRef).pipe(Effect.map((state) => state.questionBatchesByRequestId.get(requestId) ?? null))
    const putSession = (session: ChannelSession) =>
      Ref.update(stateRef, (current) => {
        const sessionsByChannelId = new Map(current.sessionsByChannelId)
        sessionsByChannelId.set(session.channelId, session)
        const sessionsBySessionId = new Map(current.sessionsBySessionId)
        sessionsBySessionId.set(session.opencode.sessionId, session)
        return {
          ...current,
          sessionsByChannelId,
          sessionsBySessionId,
        }
      })
    const setActiveRun = (session: ChannelSession, activeRun: ActiveRun | null) =>
      Ref.update(stateRef, (current) => {
        session.activeRun = activeRun

        const sessionsByChannelId = new Map(current.sessionsByChannelId)
        sessionsByChannelId.set(session.channelId, session)
        const sessionsBySessionId = new Map(current.sessionsBySessionId)
        sessionsBySessionId.set(session.opencode.sessionId, session)

        const activeRunsBySessionId = new Map(current.activeRunsBySessionId)
        if (activeRun) {
          activeRunsBySessionId.set(session.opencode.sessionId, activeRun)
        } else {
          activeRunsBySessionId.delete(session.opencode.sessionId)
        }

        return {
          ...current,
          sessionsByChannelId,
          sessionsBySessionId,
          activeRunsBySessionId,
        }
      })
    const replaceSessionHandle = (session: ChannelSession, replacement: ChannelSession["opencode"]) =>
      Ref.update(stateRef, (current) => {
        const previousSessionId = session.opencode.sessionId
        session.opencode = replacement

        const sessionsByChannelId = new Map(current.sessionsByChannelId)
        sessionsByChannelId.set(session.channelId, session)
        const sessionsBySessionId = new Map(current.sessionsBySessionId)
        sessionsBySessionId.delete(previousSessionId)
        sessionsBySessionId.set(replacement.sessionId, session)

        const activeRunsBySessionId = new Map(current.activeRunsBySessionId)
        activeRunsBySessionId.delete(previousSessionId)

        return {
          ...current,
          sessionsByChannelId,
          sessionsBySessionId,
          activeRunsBySessionId,
        }
      })
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
    const removeWorkdir = (workdir: string) =>
      Effect.promise(() => rm(resolve(workdir), { recursive: true, force: true })).pipe(Effect.ignore)

    const clearSessionGate = (channelId: string, gate: SessionGate) =>
      Ref.update(stateRef, (current) => {
        if (current.gatesByChannelId.get(channelId) !== gate) {
          return current
        }

        const gatesByChannelId = new Map(current.gatesByChannelId)
        gatesByChannelId.delete(channelId)
        return {
          ...current,
          gatesByChannelId,
        }
      })

    const withSessionGate = (channelId: string, task: Effect.Effect<ChannelSession, unknown>): Effect.Effect<ChannelSession, unknown> =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<ChannelSession, unknown>()
        const { gate: currentGate, owner } = yield* Ref.modify(
          stateRef,
          (current): readonly [SessionGateDecision, SessionRuntimeState] => {
            const existing = current.gatesByChannelId.get(channelId)
            if (existing) {
              return [{ gate: existing, owner: false }, current]
            }

            const gatesByChannelId = new Map(current.gatesByChannelId)
            gatesByChannelId.set(channelId, gate)
            return [
              { gate, owner: true },
              {
                ...current,
                gatesByChannelId,
              },
            ]
          },
        )

        if (owner) {
          yield* task.pipe(
            Effect.exit,
            Effect.tap((exit) => Deferred.done(currentGate, exit).pipe(Effect.ignore)),
            Effect.ensuring(clearSessionGate(channelId, currentGate)),
          )
        }

        return yield* Deferred.await(currentGate)
      })

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
            return Effect.promise(() => activeRun.typing.pause())
          }

          return Effect.sync(() => {
            activeRun.typing.resume()
          })
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

        yield* Effect.promise(() => activeRun.typing.pause())

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
          const questionMessage = yield* Effect.promise(() =>
            activeRun.discordMessage.reply({
              ...createQuestionMessageCreate(questionBatchView(batch)),
              allowedMentions: { repliedUser: false, parse: [] },
            }),
          )

          yield* putQuestionBatch({
            ...batch,
            message: questionMessage,
          })

          yield* logger.info("posted question batch", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            requestId: request.id,
            questionCount: request.questions.length,
          })
        } catch (error) {
          yield* logger.error("failed to post question batch", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            requestId: request.id,
            error: formatError(error),
          })

          yield* opencode.rejectQuestion(session.opencode, request.id).pipe(
            Effect.tap(() =>
              logger.warn("rejected question batch after UI failure", {
                channelId: session.channelId,
                sessionId: session.opencode.sessionId,
                requestId: request.id,
              }),
            ),
            Effect.catchAll((rejectError) =>
              logger.error("failed to reject question batch after UI failure", {
                channelId: session.channelId,
                sessionId: session.opencode.sessionId,
                requestId: request.id,
                error: formatError(rejectError),
              }),
            ),
          )

          yield* syncTypingForSession(session.opencode.sessionId)
        }
      })

    const finalizeQuestionBatch = (
      requestId: string,
      status: "answered" | "rejected",
      resolvedAnswers?: Array<QuestionAnswer>,
    ): FallibleEffect<void> =>
      Effect.gen(function* () {
        const batch = yield* updateQuestionBatch(requestId, (current) => ({
          ...current,
          status,
          resolvedAnswers,
        }))
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
            stale.map((batch) => ({
              ...batch,
              status: "expired" as const,
            })),
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
            const activeRun = state.activeRunsBySessionId.get(sessionId)
            const session = state.sessionsBySessionId.get(sessionId)
            if (!activeRun || !session) {
              return Effect.void
            }

            const progressEvents = collectProgressEvents(wrapped.payload)
            const questionAsked = getQuestionAsked(wrapped.payload)
            const questionReplied = getQuestionReplied(wrapped.payload)
            const questionRejected = getQuestionRejected(wrapped.payload)

            return Effect.gen(function* () {
              if (questionAsked) {
                yield* handleQuestionAsked(session, activeRun, questionAsked)
              }
              if (questionReplied) {
                yield* finalizeQuestionBatch(questionReplied.requestID, "answered", questionReplied.answers)
              }
              if (questionRejected) {
                yield* finalizeQuestionBatch(questionRejected.requestID, "rejected")
              }

              yield* Effect.forEach(progressEvents, (progressEvent) =>
                Queue.offer(activeRun.progressQueue, progressEvent).pipe(Effect.asVoid),
              ).pipe(Effect.asVoid)
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

    const finishProgressWorker = (
      session: ChannelSession,
      progressQueue: Queue.Queue<RunProgressEvent>,
      progressFiber: Fiber.RuntimeFiber<never, unknown>,
    ): FallibleEffect<void> =>
      Effect.gen(function* () {
        const finalizingAck = yield* Deferred.make<void>()
        const progressFiberExit = yield* progressFiber.poll
        if (progressFiberExit._tag === "None") {
          yield* Queue.offer(progressQueue, { type: "run-finalizing", ack: finalizingAck })
          const finalizingResult = yield* Deferred.await(finalizingAck).pipe(Effect.timeoutOption("2 seconds"))
          if (finalizingResult._tag === "None") {
            yield* logger.warn("progress worker finalization timed out", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
            })
          }
          return
        }

        yield* logger.warn("progress worker exited before finalization", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          exit: String(progressFiberExit.value),
        })
      })

    const sendRunFailure = (message: Message, error: unknown) =>
      Effect.promise(() =>
        message.reply({
          content: formatErrorResponse("## ❌ Opencode failed", formatError(error)),
          allowedMentions: { repliedUser: false, parse: [] },
        }),
      )

    const processRequestBatch = (
      session: ChannelSession,
      initialRequests: ReadonlyArray<RunRequest>,
    ): FallibleEffect<void> =>
      Effect.gen(function* () {
        const progressQueue = yield* Queue.unbounded<RunProgressEvent>()
        const followUpQueue = yield* Queue.unbounded<RunRequest>()
        const acceptFollowUps = yield* Ref.make(true)
        const responseMessage = initialRequests[0]!.message
        const progressFiber = yield* runProgressWorker(responseMessage, session.workdir, progressQueue).pipe(Effect.fork)

        const typing = startTypingLoop(responseMessage.channel)
        yield* setActiveRun(session, {
          discordMessage: responseMessage,
          workdir: session.workdir,
          progressQueue,
          followUpQueue,
          acceptFollowUps,
          typing,
        })

        const stopTyping = Effect.promise(() => typing.stop())
        let failed = false

        try {
          let currentBatch: ReadonlyArray<RunRequest> = initialRequests
          let result = yield* opencode.prompt(
            session.opencode,
            buildBatchedOpencodePrompt(currentBatch.map((request) => request.prompt)),
          )

          while (true) {
            yield* Ref.set(acceptFollowUps, false)
            const followUps = yield* Queue.takeAll(followUpQueue).pipe(Effect.map(Chunk.toReadonlyArray))
            if (followUps.length === 0) {
              break
            }

            yield* logger.info("absorbing queued follow-up messages into active run", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              count: followUps.length,
            })

            currentBatch = followUps
            yield* Ref.set(acceptFollowUps, true)
            result = yield* opencode.prompt(
              session.opencode,
              buildQueuedFollowUpPrompt(currentBatch.map((request) => request.prompt)),
            )
          }

          yield* stopTyping
          yield* finishProgressWorker(session, progressQueue, progressFiber)
          yield* Effect.promise(() => sendFinalResponse({ message: responseMessage, text: result.transcript }))
          yield* logger.info("completed run", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            opencodeMessageId: result.messageId,
          })
        } catch (error) {
          yield* logger.error("run failed", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: formatError(error),
          })
          yield* stopTyping
          yield* sendRunFailure(responseMessage, error)
          failed = true
        } finally {
          yield* stopTyping
          yield* setActiveRun(session, null)
          yield* expireQuestionBatchesForSession(session.opencode.sessionId)
          yield* Fiber.interrupt(progressFiber)
        }

        if (failed) {
          yield* ensureSessionHealth(session, responseMessage, "run failed with unhealthy opencode session", false).pipe(
            Effect.ignore,
          )
        }
      })

    const worker = (session: ChannelSession): Effect.Effect<never> =>
      Effect.forever(
        Queue.take(session.queue).pipe(
          Effect.flatMap((first) =>
            Queue.takeUpTo(session.queue, 64).pipe(
              Effect.flatMap((rest) => processRequestBatch(session, [first, ...Chunk.toReadonlyArray(rest)])),
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

    const createSession = (message: Message): FallibleEffect<ChannelSession> =>
      Effect.gen(function* () {
        const workdir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "opencode-discord-")))
        let opencodeSession: ChannelSession["opencode"] | null = null

        try {
          opencodeSession = yield* opencode.createSession(workdir, sessionTitle(message.channelId))
          const queue = yield* Queue.unbounded<RunRequest>()

          const session: ChannelSession = {
            channelId: message.channelId,
            opencode: opencodeSession,
            workdir,
            queue,
            activeRun: null,
          }

          yield* FiberSet.run(fiberSet, worker(session))
          yield* putSession(session)

          yield* logger.info("created channel session", {
            channelId: message.channelId,
            sessionId: opencodeSession.sessionId,
            backend: opencodeSession.backend,
            workdir,
            triggerPhrase: config.triggerPhrase,
          })

          return session
        } catch (error) {
          if (opencodeSession) {
            yield* opencodeSession.close().pipe(Effect.ignore)
          }
          yield* removeWorkdir(workdir)
          throw error
        }
      })

    const createOrGetSession = (message: Message): FallibleEffect<ChannelSession> =>
      Effect.gen(function* () {
        const existing = yield* getSession(message.channelId)
        if (existing) {
          return existing
        }
        return yield* withSessionGate(
          message.channelId,
          Effect.gen(function* () {
            const current = yield* getSession(message.channelId)
            if (current) {
              return current
            }
            return yield* createSession(message)
          }),
        )
      })

    const recreateSession = (
      session: ChannelSession,
      message: Message,
      reason: string,
    ): FallibleEffect<ChannelSession> =>
      withSessionGate(
        message.channelId,
        Effect.gen(function* () {
          const current = yield* getSession(message.channelId)
          if (!current) {
            return yield* createSession(message)
          }

          if (current.opencode.sessionId !== session.opencode.sessionId) {
            return current
          }

          const previous = current.opencode
          const replacement = yield* opencode.createSession(current.workdir, sessionTitle(message.channelId))
          yield* replaceSessionHandle(current, replacement)
          yield* previous.close().pipe(Effect.ignore)
          yield* logger.warn("recovered channel session", {
            channelId: current.channelId,
            previousSessionId: previous.sessionId,
            sessionId: replacement.sessionId,
            backend: replacement.backend,
            workdir: current.workdir,
            reason,
          })
          return current
        }),
      )

    const ensureSessionHealth = (
      session: ChannelSession,
      message: Message,
      reason: string,
      allowBusySession = true,
    ): FallibleEffect<ChannelSession> =>
      Effect.gen(function* () {
        if (allowBusySession && session.activeRun) {
          return session
        }

        const healthy = yield* opencode.isHealthy(session.opencode)
        if (healthy) {
          return session
        }

        return yield* recreateSession(session, message, reason)
      })

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

    const persistQuestionBatch = (
      requestId: string,
      update: (batch: PendingQuestionBatch) => PendingQuestionBatch | null,
    ): FallibleEffect<PendingQuestionBatch | null> => updateQuestionBatch(requestId, update)

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
              yield* Effect.promise(() =>
                interaction.reply(questionInteractionReply("Saved custom answer.")),
              ).pipe(Effect.ignore)
              return true
            }
          case "submit":
            if (!interaction.isButton()) {
              return false
            }

            {
              const submitting = yield* persistQuestionBatch(action.requestID, (current) => ({
                ...current,
                status: "submitting",
              }))
              if (!submitting) {
                yield* replyToQuestionInteraction(interaction, "This question prompt has expired.")
                return true
              }

              yield* Effect.promise(() =>
                interaction.update(createQuestionMessageEdit(questionBatchView(submitting))),
              )

              const answers = buildQuestionAnswers(submitting.request, submitting.drafts)
              const submitResult = yield* opencode.replyToQuestion(submitting.session.opencode, submitting.request.id, answers).pipe(
                Effect.either,
              )
              if (submitResult._tag === "Left") {
                const restored = yield* persistQuestionBatch(action.requestID, (current) => ({
                  ...current,
                  status: "active",
                }))
                if (restored) {
                  yield* editQuestionMessage(restored).pipe(Effect.ignore)
                }
                yield* Effect.promise(() =>
                  interaction.followUp(
                    questionInteractionReply(`Failed to submit answers: ${formatError(submitResult.left)}`),
                  ),
                ).pipe(Effect.ignore)
                return true
              }

              yield* finalizeQuestionBatch(submitting.request.id, "answered", answers)
              return true
            }
          case "reject":
            if (!interaction.isButton()) {
              return false
            }

            {
              const rejecting = yield* persistQuestionBatch(action.requestID, (current) => ({
                ...current,
                status: "submitting",
              }))
              if (!rejecting) {
                yield* replyToQuestionInteraction(interaction, "This question prompt has expired.")
                return true
              }

              yield* Effect.promise(() =>
                interaction.update(createQuestionMessageEdit(questionBatchView(rejecting))),
              )

              const rejectResult = yield* opencode.rejectQuestion(rejecting.session.opencode, rejecting.request.id).pipe(
                Effect.either,
              )
              if (rejectResult._tag === "Left") {
                const restored = yield* persistQuestionBatch(action.requestID, (current) => ({
                  ...current,
                  status: "active",
                }))
                if (restored) {
                  yield* editQuestionMessage(restored).pipe(Effect.ignore)
                }
                yield* Effect.promise(() =>
                  interaction.followUp(
                    questionInteractionReply(`Failed to reject questions: ${formatError(rejectResult.left)}`),
                  ),
                ).pipe(Effect.ignore)
                return true
              }

              yield* finalizeQuestionBatch(rejecting.request.id, "rejected")
              return true
            }
        }
      })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        for (const session of state.sessionsByChannelId.values()) {
          yield* Queue.shutdown(session.queue)
          yield* session.opencode.close().pipe(Effect.ignore)
          yield* removeWorkdir(session.workdir)
        }
        yield* FiberSet.clear(fiberSet)
      }),
    )

    return {
      submit: (message, invocation): FallibleEffect<void> =>
        Effect.gen(function* () {
          const session = yield* getUsableSession(message, "health probe failed before queueing run")
          const prompt = buildOpencodePrompt({
            userTag: message.author.tag,
            content: invocation.prompt,
            replyContext: invocation.replyContext,
            attachmentSummary: summarizeAttachments(message),
            embedSummary: summarizeEmbeds(message),
          })

          const request = {
            message,
            prompt,
          } satisfies RunRequest

          if (session.activeRun) {
            const acceptFollowUps = yield* Ref.get(session.activeRun.acceptFollowUps)
            if (acceptFollowUps) {
              yield* Queue.offer(session.activeRun.followUpQueue, request)
              yield* logger.info("queued follow-up on active run", {
                channelId: message.channelId,
                sessionId: session.opencode.sessionId,
                author: message.author.tag,
              })
              return
            }
          }

          yield* Queue.offer(session.queue, request)

          yield* logger.info("queued run", {
            channelId: message.channelId,
            sessionId: session.opencode.sessionId,
            author: message.author.tag,
          })
        }),
      getActiveRunBySessionId,
      handleInteraction: handleQuestionInteraction,
    } satisfies ChannelSessionsShape
  }),
)
