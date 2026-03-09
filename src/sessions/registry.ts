import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import { Chunk, Context, Deferred, Effect, Fiber, FiberSet, Layer, Queue, Ref } from "effect"
import { ChannelType, MessageFlags, type Interaction, type Message, type SendableChannels } from "discord.js"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"

import { AppConfig } from "@/config.ts"
import { formatErrorResponse } from "@/discord/formatting.ts"
import { editInfoCard, sendInfoCard, upsertInfoCard } from "@/discord/info-card.ts"
import {
  buildBatchedOpencodePrompt,
  buildOpencodePrompt,
  buildQueuedFollowUpPrompt,
  promptMessageContext,
  sendFinalResponse,
  startTypingLoop,
} from "@/discord/messages.ts"
import { buildSessionSystemAppend } from "@/discord/system-context.ts"
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
  decideRunCompletion,
} from "@/sessions/command-lifecycle.ts"
import { collectAttachmentMessages } from "@/sessions/message-context.ts"
import { collectProgressEvents, runProgressWorker } from "@/sessions/progress.ts"
import { expireQuestionBatch, setQuestionBatchStatus } from "@/sessions/question-batch-state.ts"
import { enqueueRunRequest } from "@/sessions/request-routing.ts"
import { admitRequestBatchToActiveRun, type NonEmptyRunRequestBatch } from "@/sessions/run-batch.ts"
import {
  buildSessionCreateSpec,
  type ActiveRun,
  type ChannelSession,
  type QuestionOutcome,
  type RunProgressEvent,
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
  idleCompactionCardsBySessionId: Map<string, Message>
  questionBatchesByRequestId: Map<string, PendingQuestionBatch>
}

const noQuestionOutcome = (): QuestionOutcome => ({ _tag: "none" })
const questionUiFailureOutcome = (message: string, notified = false): QuestionOutcome => ({
  _tag: "ui-failure",
  message,
  notified,
})
const createSessionRuntimeState = (): SessionRuntimeState => ({
  sessionsByChannelId: new Map<string, ChannelSession>(),
  sessionsBySessionId: new Map<string, ChannelSession>(),
  activeRunsBySessionId: new Map<string, ActiveRun>(),
  gatesByChannelId: new Map<string, SessionGate>(),
  idleCompactionCardsBySessionId: new Map<string, Message>(),
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
    const getIdleCompactionCard = (sessionId: string) =>
      Ref.get(stateRef).pipe(Effect.map((state) => state.idleCompactionCardsBySessionId.get(sessionId) ?? null))
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

        const idleCompactionCardsBySessionId = new Map(current.idleCompactionCardsBySessionId)
        const idleCompactionCard = idleCompactionCardsBySessionId.get(previousSessionId)
        idleCompactionCardsBySessionId.delete(previousSessionId)
        if (idleCompactionCard) {
          idleCompactionCardsBySessionId.set(replacement.sessionId, idleCompactionCard)
        }

        return {
          ...current,
          sessionsByChannelId,
          sessionsBySessionId,
          activeRunsBySessionId,
          idleCompactionCardsBySessionId,
        }
      })
    const setIdleCompactionCard = (sessionId: string, message: Message | null) =>
      Ref.update(stateRef, (current) => {
        const idleCompactionCardsBySessionId = new Map(current.idleCompactionCardsBySessionId)
        if (message) {
          idleCompactionCardsBySessionId.set(sessionId, message)
        } else {
          idleCompactionCardsBySessionId.delete(sessionId)
        }
        return {
          ...current,
          idleCompactionCardsBySessionId,
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
    const removeSessionRoot = (rootDir: string) =>
      Effect.promise(() => rm(resolve(rootDir), { recursive: true, force: true })).pipe(Effect.ignore)

    const createSessionPaths = () =>
      Effect.promise(async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "opencode-discord-"))
        const workdir = join(rootDir, "home", "workspace")
        await mkdir(workdir, { recursive: true })
        return {
          rootDir,
          workdir,
        }
      })

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
      resolvedAnswers?: Array<QuestionAnswer>,
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

    const processRequestBatch = (
      session: ChannelSession,
      initialRequests: NonEmptyRunRequestBatch,
    ): FallibleEffect<void> =>
      Effect.gen(function* () {
        const progressQueue = yield* Queue.unbounded<RunProgressEvent>()
        const followUpQueue = yield* Queue.unbounded<RunRequest>()
        const acceptFollowUps = yield* Ref.make(true)
        const responseMessage = initialRequests[0]!.message
        const progressFiber = yield* runProgressWorker(responseMessage, session.workdir, progressQueue).pipe(Effect.fork)
        const activeRun: ActiveRun = {
          discordMessage: responseMessage,
          workdir: session.workdir,
          attachmentMessagesById: new Map<string, Message>(),
          progressQueue,
          followUpQueue,
          acceptFollowUps,
          typing: startTypingLoop(responseMessage.channel),
          questionOutcome: noQuestionOutcome(),
          interruptRequested: false,
        }
        const initialPrompt = admitRequestBatchToActiveRun(activeRun.attachmentMessagesById, initialRequests, "initial")
        yield* setActiveRun(session, activeRun)

        const stopTyping = Effect.promise(() => activeRun.typing.stop())
        let failed = false

        try {
          let result = yield* opencode.prompt(session.opencode, initialPrompt)

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

            const followUpBatch = followUps as NonEmptyRunRequestBatch
            const followUpPrompt = admitRequestBatchToActiveRun(
              activeRun.attachmentMessagesById,
              followUpBatch,
              "follow-up",
            )
            yield* Ref.set(acceptFollowUps, true)
            result = yield* opencode.prompt(session.opencode, followUpPrompt)
          }

          const questionOutcome = activeRun.questionOutcome
          const completion = decideRunCompletion({
            transcript: result.transcript,
            questionOutcome,
            interruptRequested: activeRun.interruptRequested,
          })

          yield* stopTyping
          yield* finishProgressWorker(session, progressQueue, progressFiber)
          switch (completion.type) {
            case "send-final-response":
              yield* Effect.promise(() => sendFinalResponse({ message: responseMessage, text: result.transcript }))
              break
            case "send-question-ui-failure":
              yield* sendQuestionUiFailure(responseMessage, completion.message)
              break
            case "suppress-response":
              break
          }
          yield* logger.info("completed run", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            opencodeMessageId: result.messageId,
          })
        } catch (error) {
          if (activeRun.interruptRequested) {
            yield* logger.info("interrupted run", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              error: formatError(error),
            })
            yield* stopTyping
          } else {
            yield* logger.error("run failed", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              error: formatError(error),
            })
            yield* stopTyping
            yield* sendRunFailure(responseMessage, error)
            failed = true
          }
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
        const { rootDir, workdir } = yield* createSessionPaths()
        let opencodeSession: ChannelSession["opencode"] | null = null
        const systemPromptAppend = buildSessionSystemAppend({
          message,
          additionalInstructions: config.sessionInstructions,
        })
        const sessionCreateSpec = buildSessionCreateSpec({
          channelId: message.channelId,
          workdir,
          systemPromptAppend,
        })

        try {
          opencodeSession = yield* opencode.createSession(
            sessionCreateSpec.workdir,
            sessionCreateSpec.title,
            sessionCreateSpec.systemPromptAppend,
          )
          const queue = yield* Queue.unbounded<RunRequest>()

          const session: ChannelSession = {
            channelId: message.channelId,
            opencode: opencodeSession,
            systemPromptAppend,
            rootDir,
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
          yield* removeSessionRoot(rootDir)
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
          const sessionCreateSpec = buildSessionCreateSpec({
            channelId: message.channelId,
            workdir: current.workdir,
            systemPromptAppend: current.systemPromptAppend,
          })
          const replacement = yield* opencode.createSession(
            sessionCreateSpec.workdir,
            sessionCreateSpec.title,
            sessionCreateSpec.systemPromptAppend,
          )
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

            {
              const submitting = yield* persistQuestionBatch(action.requestID, (current) => ({
                ...setQuestionBatchStatus(current, "submitting"),
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
                const restored = yield* persistQuestionBatch(action.requestID, (current) =>
                  setQuestionBatchStatus(current, "active"),
                )
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
                ...setQuestionBatchStatus(current, "submitting"),
              }))
              if (!rejecting) {
                yield* replyToQuestionInteraction(interaction, "This question prompt has expired.")
                return true
              }

              yield* Effect.promise(() =>
                interaction.update(createQuestionMessageEdit(questionBatchView(rejecting))),
              )

              if (rejecting.session.activeRun) {
                rejecting.session.activeRun.questionOutcome = { _tag: "user-rejected" }
              }
              const rejectResult = yield* opencode.rejectQuestion(rejecting.session.opencode, rejecting.request.id).pipe(
                Effect.either,
              )
              if (rejectResult._tag === "Left") {
                if (rejecting.session.activeRun) {
                  rejecting.session.activeRun.questionOutcome = noQuestionOutcome()
                }
                const restored = yield* persistQuestionBatch(action.requestID, (current) =>
                  setQuestionBatchStatus(current, "active"),
                )
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
          yield* removeSessionRoot(session.rootDir)
        }
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
