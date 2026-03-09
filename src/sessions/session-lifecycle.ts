import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import type { Message } from "discord.js"
import { Deferred, Effect, Queue, Ref } from "effect"

import { buildSessionSystemAppend } from "@/discord/system-context.ts"
import type { OpencodeServiceShape, SessionHandle } from "@/opencode/service.ts"
import { buildSessionCreateSpec, type ActiveRun, type ChannelSession, type RunRequest } from "@/sessions/session.ts"
import type { LoggerShape } from "@/util/logging.ts"

export type SessionGate = Deferred.Deferred<ChannelSession, unknown>

export type SessionLifecycleState = {
  sessionsByChannelId: Map<string, ChannelSession>
  sessionsBySessionId: Map<string, ChannelSession>
  activeRunsBySessionId: Map<string, ActiveRun>
  gatesByChannelId: Map<string, SessionGate>
  idleCompactionCardsBySessionId: Map<string, Message>
}

type SessionGateDecision = {
  gate: SessionGate
  owner: boolean
}

type SessionPaths = {
  rootDir: string
  workdir: string
}

type SessionLifecycleRuntime<State extends SessionLifecycleState> = {
  stateRef: Ref.Ref<State>
  createOpencodeSession: (workdir: string, title: string, systemPromptAppend?: string) => Effect.Effect<SessionHandle, unknown>
  isSessionHealthy: OpencodeServiceShape["isHealthy"]
  startWorker: (session: ChannelSession) => Effect.Effect<void, unknown>
  logger: LoggerShape
  sessionInstructions: string
  triggerPhrase: string
  createSessionPaths?: () => Effect.Effect<SessionPaths, unknown>
  removeSessionRoot?: (rootDir: string) => Effect.Effect<void, unknown>
}

const defaultCreateSessionPaths = () =>
  Effect.promise(async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-discord-"))
    const workdir = join(rootDir, "home", "workspace")
    await mkdir(workdir, { recursive: true })
    return {
      rootDir,
      workdir,
    }
  })

const defaultRemoveSessionRoot = (rootDir: string) =>
  Effect.promise(() => rm(resolve(rootDir), { recursive: true, force: true })).pipe(Effect.ignore)

export const createSessionLifecycle = <State extends SessionLifecycleState>(runtime: SessionLifecycleRuntime<State>) => {
  const createSessionPaths = runtime.createSessionPaths ?? defaultCreateSessionPaths
  const removeSessionRoot = runtime.removeSessionRoot ?? defaultRemoveSessionRoot

  const getSession = (channelId: string) =>
    Ref.get(runtime.stateRef).pipe(Effect.map((state) => state.sessionsByChannelId.get(channelId)))

  const getActiveRunBySessionId = (sessionId: string) =>
    Ref.get(runtime.stateRef).pipe(Effect.map((state) => state.activeRunsBySessionId.get(sessionId) ?? null))

  const getIdleCompactionCard = (sessionId: string) =>
    Ref.get(runtime.stateRef).pipe(Effect.map((state) => state.idleCompactionCardsBySessionId.get(sessionId) ?? null))

  const putSession = (session: ChannelSession) =>
    Ref.update(runtime.stateRef, (current) => {
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
    Ref.update(runtime.stateRef, (current) => {
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
    Ref.update(runtime.stateRef, (current) => {
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
    Ref.update(runtime.stateRef, (current) => {
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

  const clearSessionGate = (channelId: string, gate: SessionGate) =>
    Ref.update(runtime.stateRef, (current) => {
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
        runtime.stateRef,
        (current): readonly [SessionGateDecision, State] => {
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

  const createSession = (message: Message): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      const { rootDir, workdir } = yield* createSessionPaths()
      let opencodeSession: ChannelSession["opencode"] | null = null
      const systemPromptAppend = buildSessionSystemAppend({
        message,
        additionalInstructions: runtime.sessionInstructions,
      })
      const sessionCreateSpec = buildSessionCreateSpec({
        channelId: message.channelId,
        workdir,
        systemPromptAppend,
      })

      return yield* Effect.gen(function* () {
        opencodeSession = yield* runtime.createOpencodeSession(
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

        yield* runtime.startWorker(session)
        yield* putSession(session)

        yield* runtime.logger.info("created channel session", {
          channelId: message.channelId,
          sessionId: opencodeSession.sessionId,
          backend: opencodeSession.backend,
          workdir,
          triggerPhrase: runtime.triggerPhrase,
        })

        return session
      }).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            if (opencodeSession) {
              yield* opencodeSession.close().pipe(Effect.ignore)
            }
            yield* removeSessionRoot(rootDir)
          }).pipe(Effect.ignore),
        ),
      )
    })

  const createOrGetSession = (message: Message): Effect.Effect<ChannelSession, unknown> =>
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
  ): Effect.Effect<ChannelSession, unknown> =>
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
        const replacement = yield* runtime.createOpencodeSession(
          sessionCreateSpec.workdir,
          sessionCreateSpec.title,
          sessionCreateSpec.systemPromptAppend,
        )
        yield* replaceSessionHandle(current, replacement)
        yield* previous.close().pipe(Effect.ignore)
        yield* runtime.logger.warn("recovered channel session", {
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
  ): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      if (allowBusySession && session.activeRun) {
        return session
      }

      const healthy = yield* runtime.isSessionHealthy(session.opencode)
      if (healthy) {
        return session
      }

      return yield* recreateSession(session, message, reason)
    })

  const shutdownSessions = () =>
    Ref.get(runtime.stateRef).pipe(
      Effect.flatMap((state) =>
        Effect.forEach(
          state.sessionsByChannelId.values(),
          (session) =>
            Queue.shutdown(session.queue).pipe(
              Effect.zipRight(session.opencode.close().pipe(Effect.ignore)),
              Effect.zipRight(removeSessionRoot(session.rootDir)),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    )

  return {
    getSession,
    getActiveRunBySessionId,
    getIdleCompactionCard,
    setActiveRun,
    setIdleCompactionCard,
    createOrGetSession,
    ensureSessionHealth,
    shutdownSessions,
  } as const
}
