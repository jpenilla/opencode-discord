import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import { Chunk, Context, Deferred, Effect, Fiber, FiberSet, Layer, Queue, Ref } from "effect"
import type { Message } from "discord.js"

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
import { OpencodeEventQueue, getEventSessionId } from "@/opencode/events.ts"
import type { Invocation } from "@/discord/triggers.ts"
import { OpencodeService } from "@/opencode/service.ts"
import { collectProgressEvents, runProgressWorker } from "@/sessions/progress.ts"
import type { ActiveRun, ChannelSession, RunProgressEvent, RunRequest } from "@/sessions/session.ts"
import { Logger } from "@/util/logging.ts"

export type ChannelSessionsShape = {
  submit: (message: Message, invocation: Invocation) => Effect.Effect<void, unknown>
  getActiveRunBySessionId: (sessionId: string) => Effect.Effect<ActiveRun | null>
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
type SessionRuntimeState = {
  sessionsByChannelId: Map<string, ChannelSession>
  activeRunsBySessionId: Map<string, ActiveRun>
  gatesByChannelId: Map<string, SessionGate>
}
const sessionTitle = (channelId: string) => `Discord #${channelId}`
const createSessionRuntimeState = (): SessionRuntimeState => ({
  sessionsByChannelId: new Map<string, ChannelSession>(),
  activeRunsBySessionId: new Map<string, ActiveRun>(),
  gatesByChannelId: new Map<string, SessionGate>(),
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
    const putSession = (session: ChannelSession) =>
      Ref.update(stateRef, (current) => {
        const sessionsByChannelId = new Map(current.sessionsByChannelId)
        sessionsByChannelId.set(session.channelId, session)
        return {
          ...current,
          sessionsByChannelId,
        }
      })
    const setActiveRun = (session: ChannelSession, activeRun: ActiveRun | null) =>
      Ref.update(stateRef, (current) => {
        session.activeRun = activeRun

        const sessionsByChannelId = new Map(current.sessionsByChannelId)
        sessionsByChannelId.set(session.channelId, session)

        const activeRunsBySessionId = new Map(current.activeRunsBySessionId)
        if (activeRun) {
          activeRunsBySessionId.set(session.opencode.sessionId, activeRun)
        } else {
          activeRunsBySessionId.delete(session.opencode.sessionId)
        }

        return {
          ...current,
          sessionsByChannelId,
          activeRunsBySessionId,
        }
      })
    const replaceSessionHandle = (session: ChannelSession, replacement: ChannelSession["opencode"]) =>
      Ref.update(stateRef, (current) => {
        const previousSessionId = session.opencode.sessionId
        session.opencode = replacement

        const sessionsByChannelId = new Map(current.sessionsByChannelId)
        sessionsByChannelId.set(session.channelId, session)

        const activeRunsBySessionId = new Map(current.activeRunsBySessionId)
        activeRunsBySessionId.delete(previousSessionId)

        return {
          ...current,
          sessionsByChannelId,
          activeRunsBySessionId,
        }
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

    yield* eventQueue.take().pipe(
      Effect.flatMap((wrapped) => {
        const sessionId = getEventSessionId(wrapped.payload)
        if (!sessionId) {
          return Effect.void
        }

        return Ref.get(stateRef).pipe(
          Effect.flatMap((state) => {
            const activeRun = state.activeRunsBySessionId.get(sessionId)
            if (!activeRun) {
              return Effect.void
            }

            const progressEvents = collectProgressEvents(wrapped.payload)

            return Effect.forEach(progressEvents, (progressEvent) =>
              Queue.offer(activeRun.progressQueue, progressEvent).pipe(Effect.asVoid),
            ).pipe(Effect.asVoid)
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

        yield* setActiveRun(session, {
          discordMessage: responseMessage,
          workdir: session.workdir,
          progressQueue,
          followUpQueue,
          acceptFollowUps,
        })

        const stopTypingLoop = startTypingLoop(responseMessage.channel)
        const stopTyping = Effect.promise(() => stopTypingLoop())
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
    } satisfies ChannelSessionsShape
  }),
)
