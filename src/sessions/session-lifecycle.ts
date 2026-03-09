import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

import type { Message } from "discord.js"
import { Deferred, Effect, Queue, Ref } from "effect"

import { buildSessionSystemAppend } from "@/discord/system-context.ts"
import type { OpencodeServiceShape, SessionHandle } from "@/opencode/service.ts"
import { buildSessionCreateSpec, type ActiveRun, type ChannelSession, type RunRequest } from "@/sessions/session.ts"
import { sessionRootDir, sessionWorkdirFromRoot } from "@/state/paths.ts"
import type { PersistedChannelSession } from "@/state/store.ts"
import type { LoggerShape } from "@/util/logging.ts"

export type SessionGate = Deferred.Deferred<ChannelSession, unknown>

export type SessionLifecycleState = {
  sessionsByChannelId: Map<string, ChannelSession>
  sessionsBySessionId: Map<string, ChannelSession>
  activeRunsBySessionId: Map<string, ActiveRun>
  gatesByChannelId: Map<string, SessionGate>
  idleCompactionCardsBySessionId: Map<string, Message>
}

export type SessionContext = {
  session: ChannelSession
  activeRun: ActiveRun | null
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
  attachOpencodeSession: (workdir: string, sessionId: string, systemPromptAppend?: string) => Effect.Effect<SessionHandle, unknown>
  getPersistedSession: (channelId: string) => Effect.Effect<PersistedChannelSession | null, unknown>
  upsertPersistedSession: (session: PersistedChannelSession) => Effect.Effect<void, unknown>
  touchPersistedSession: (channelId: string, lastActivityAt: number) => Effect.Effect<void, unknown>
  deletePersistedSession: (channelId: string) => Effect.Effect<void, unknown>
  isSessionHealthy: OpencodeServiceShape["isHealthy"]
  startWorker: (session: ChannelSession) => Effect.Effect<void, unknown>
  logger: LoggerShape
  sessionInstructions: string
  triggerPhrase: string
  idleTimeoutMs?: number
  sessionsRootDir: string
  createSessionPaths?: (channelId: string) => Effect.Effect<SessionPaths, unknown>
  deleteSessionRoot?: (rootDir: string) => Effect.Effect<void, unknown>
}

const defaultCreateSessionPaths = (sessionsRootDir: string, channelId: string) =>
  Effect.promise(async () => {
    const rootDir = sessionRootDir(sessionsRootDir, channelId)
    const workdir = sessionWorkdirFromRoot(rootDir)
    await mkdir(workdir, { recursive: true })
    return {
      rootDir,
      workdir,
    }
  })

const defaultDeleteSessionRoot = (rootDir: string) =>
  Effect.promise(() => rm(resolve(rootDir), { recursive: true, force: true })).pipe(Effect.ignore)

export const createSessionLifecycle = <State extends SessionLifecycleState>(runtime: SessionLifecycleRuntime<State>) => {
  const createSessionPaths = runtime.createSessionPaths ?? ((channelId: string) => defaultCreateSessionPaths(runtime.sessionsRootDir, channelId))
  const deleteSessionRoot = runtime.deleteSessionRoot ?? defaultDeleteSessionRoot

  const getSession = (channelId: string) =>
    Ref.get(runtime.stateRef).pipe(Effect.map((state) => state.sessionsByChannelId.get(channelId)))

  const getActiveRunBySessionId = (sessionId: string) =>
    Ref.get(runtime.stateRef).pipe(Effect.map((state) => state.activeRunsBySessionId.get(sessionId) ?? null))

  const getSessionContext = (sessionId: string) =>
    Ref.get(runtime.stateRef).pipe(
      Effect.map((state): SessionContext | null => {
        const session = state.sessionsBySessionId.get(sessionId)
        if (!session) {
          return null
        }
        return {
          session,
          activeRun: state.activeRunsBySessionId.get(sessionId) ?? null,
        }
      }),
    )

  const getIdleCompactionCard = (sessionId: string) =>
    Ref.get(runtime.stateRef).pipe(Effect.map((state) => state.idleCompactionCardsBySessionId.get(sessionId) ?? null))

  const takeIdleCompactionCard = (sessionId: string) =>
    Ref.modify(runtime.stateRef, (current): readonly [Message | null, State] => {
      const existing = current.idleCompactionCardsBySessionId.get(sessionId) ?? null
      if (!existing) {
        return [null, current]
      }

      const idleCompactionCardsBySessionId = new Map(current.idleCompactionCardsBySessionId)
      idleCompactionCardsBySessionId.delete(sessionId)
      return [
        existing,
        {
          ...current,
          idleCompactionCardsBySessionId,
        },
      ]
    })

  const toPersistedSession = (session: ChannelSession): PersistedChannelSession => ({
    channelId: session.channelId,
    opencodeSessionId: session.opencode.sessionId,
    rootDir: session.rootDir,
    systemPromptAppend: session.systemPromptAppend,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
  })

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

  const deleteSession = (session: ChannelSession) =>
    Ref.update(runtime.stateRef, (current) => {
      const sessionsByChannelId = new Map(current.sessionsByChannelId)
      sessionsByChannelId.delete(session.channelId)
      const sessionsBySessionId = new Map(current.sessionsBySessionId)
      sessionsBySessionId.delete(session.opencode.sessionId)
      const activeRunsBySessionId = new Map(current.activeRunsBySessionId)
      activeRunsBySessionId.delete(session.opencode.sessionId)
      const idleCompactionCardsBySessionId = new Map(current.idleCompactionCardsBySessionId)
      idleCompactionCardsBySessionId.delete(session.opencode.sessionId)
      return {
        ...current,
        sessionsByChannelId,
        sessionsBySessionId,
        activeRunsBySessionId,
        idleCompactionCardsBySessionId,
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

  const touchSessionActivity = (session: ChannelSession, at = Date.now()) =>
    Effect.gen(function* () {
      session.lastActivityAt = at
      yield* runtime.touchPersistedSession(session.channelId, at)
    })

  const activateSession = (
    session: ChannelSession,
    options?: {
      removePersistedOnFailure?: boolean
    },
  ): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      yield* runtime.upsertPersistedSession(toPersistedSession(session))
      yield* putSession(session)
      yield* runtime.startWorker(session)
      return session
    }).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          yield* deleteSession(session)
          yield* session.opencode.close().pipe(Effect.ignore)
          if (options?.removePersistedOnFailure) {
            yield* runtime.deletePersistedSession(session.channelId).pipe(Effect.ignore)
          }
        }).pipe(Effect.ignore),
      ),
    )

  const createSessionAt = (input: {
    channelId: string
    rootDir: string
    workdir: string
    systemPromptAppend?: string
    createdAt: number
    lastActivityAt: number
    logReason?: string
    removePersistedOnActivationFailure?: boolean
    deleteNewRootOnFailure?: boolean
  }): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      const sessionCreateSpec = buildSessionCreateSpec({
        channelId: input.channelId,
        workdir: input.workdir,
        systemPromptAppend: input.systemPromptAppend,
      })

      const opencodeSession = yield* runtime.createOpencodeSession(
        sessionCreateSpec.workdir,
        sessionCreateSpec.title,
        sessionCreateSpec.systemPromptAppend,
      )
      const queue = yield* Queue.unbounded<RunRequest>()

      const session: ChannelSession = {
        channelId: input.channelId,
        opencode: opencodeSession,
        systemPromptAppend: input.systemPromptAppend,
        rootDir: input.rootDir,
        workdir: input.workdir,
        createdAt: input.createdAt,
        lastActivityAt: input.lastActivityAt,
        queue,
        activeRun: null,
      }

      yield* activateSession(session, {
        removePersistedOnFailure: input.removePersistedOnActivationFailure,
      })

      yield* runtime.logger.info("created channel session", {
        channelId: input.channelId,
        sessionId: opencodeSession.sessionId,
        backend: opencodeSession.backend,
        workdir: input.workdir,
        triggerPhrase: runtime.triggerPhrase,
        reason: input.logReason,
      })

      return session
    }).pipe(
      Effect.onError(() =>
        input.deleteNewRootOnFailure
          ? deleteSessionRoot(input.rootDir).pipe(Effect.ignore)
          : Effect.void,
      ),
    )

  const createSession = (message: Message): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      const systemPromptAppend = buildSessionSystemAppend({
        message,
        additionalInstructions: runtime.sessionInstructions,
      })
      const { rootDir, workdir } = yield* createSessionPaths(message.channelId)
      const now = Date.now()

      return yield* createSessionAt({
        channelId: message.channelId,
        rootDir,
        systemPromptAppend,
        workdir,
        createdAt: now,
        lastActivityAt: now,
        removePersistedOnActivationFailure: true,
        deleteNewRootOnFailure: true,
      })
    })

  const attachPersistedSession = (
    channelId: string,
    persisted: PersistedChannelSession,
    lastActivityAt = Date.now(),
  ): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      const workdir = sessionWorkdirFromRoot(persisted.rootDir)

      const opencodeSession = yield* runtime.attachOpencodeSession(
        workdir,
        persisted.opencodeSessionId,
        persisted.systemPromptAppend,
      )
      const queue = yield* Queue.unbounded<RunRequest>()
      const session: ChannelSession = {
        channelId,
        opencode: opencodeSession,
        systemPromptAppend: persisted.systemPromptAppend,
        rootDir: persisted.rootDir,
        workdir,
        createdAt: persisted.createdAt,
        lastActivityAt,
        queue,
        activeRun: null,
      }

      yield* activateSession(session)
      yield* runtime.logger.info("attached channel session", {
        channelId,
        sessionId: opencodeSession.sessionId,
        backend: opencodeSession.backend,
        workdir,
      })
      return session
    })

  const restoreOrCreateSession = (message: Message): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      const persisted = yield* runtime.getPersistedSession(message.channelId)
      if (!persisted) {
        return yield* createSession(message)
      }

      const now = Date.now()
      const attached = yield* attachPersistedSession(message.channelId, persisted, now).pipe(Effect.either)
      if (attached._tag === "Right") {
        return attached.right
      }

      yield* runtime.logger.warn("failed to attach persisted channel session", {
        channelId: message.channelId,
        sessionId: persisted.opencodeSessionId,
        rootDir: persisted.rootDir,
        error: attached.left instanceof Error ? attached.left.message : String(attached.left),
      })

      return yield* createSessionAt({
        channelId: message.channelId,
        rootDir: persisted.rootDir,
        workdir: sessionWorkdirFromRoot(persisted.rootDir),
        systemPromptAppend: persisted.systemPromptAppend,
        createdAt: persisted.createdAt,
        lastActivityAt: now,
        logReason: "attach failed; created replacement session",
        removePersistedOnActivationFailure: false,
        deleteNewRootOnFailure: false,
      })
    })

  const createOrGetSession = (message: Message): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      const existing = yield* getSession(message.channelId)
      if (existing) {
        yield* touchSessionActivity(existing)
        return existing
      }

      return yield* withSessionGate(
        message.channelId,
        Effect.gen(function* () {
          const current = yield* getSession(message.channelId)
          if (current) {
            yield* touchSessionActivity(current)
            return current
          }
          return yield* restoreOrCreateSession(message)
        }),
      )
    })

  const getOrRestoreSession = (channelId: string): Effect.Effect<ChannelSession | null, unknown> =>
    Effect.gen(function* () {
      const existing = yield* getSession(channelId)
      if (existing) {
        yield* touchSessionActivity(existing)
        return existing
      }

      const persisted = yield* runtime.getPersistedSession(channelId)
      if (!persisted) {
        return null
      }

      return yield* withSessionGate(
        channelId,
        Effect.gen(function* () {
          const current = yield* getSession(channelId)
          if (current) {
            yield* touchSessionActivity(current)
            return current
          }
          return yield* attachPersistedSession(channelId, persisted)
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
        yield* runtime.upsertPersistedSession(toPersistedSession(current))
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

  const closeExpiredSessions = (now = Date.now()) =>
    Ref.get(runtime.stateRef).pipe(
      Effect.flatMap((state) =>
        Effect.forEach(
          state.sessionsByChannelId.values(),
          (session) =>
            session.activeRun ||
            state.idleCompactionCardsBySessionId.has(session.opencode.sessionId) ||
            !runtime.idleTimeoutMs ||
            now - session.lastActivityAt < runtime.idleTimeoutMs
              ? Effect.void
              : Effect.gen(function* () {
                  yield* deleteSession(session)
                  yield* Queue.shutdown(session.queue).pipe(Effect.ignore)
                  yield* session.opencode.close().pipe(Effect.ignore)
                  yield* runtime.logger.info("closed idle channel session", {
                    channelId: session.channelId,
                    sessionId: session.opencode.sessionId,
                    idleForMs: now - session.lastActivityAt,
                    workdir: session.workdir,
                  })
                }),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    )

  const shutdownSessions = () =>
    Ref.get(runtime.stateRef).pipe(
      Effect.flatMap((state) =>
        Effect.forEach(
          state.sessionsByChannelId.values(),
          (session) =>
            deleteSession(session).pipe(
              Effect.zipRight(Queue.shutdown(session.queue).pipe(Effect.ignore)),
              Effect.zipRight(session.opencode.close().pipe(Effect.ignore)),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    )

  return {
    getSession,
    getActiveRunBySessionId,
    getSessionContext,
    getIdleCompactionCard,
    takeIdleCompactionCard,
    setActiveRun,
    setIdleCompactionCard,
    createOrGetSession,
    getOrRestoreSession,
    ensureSessionHealth,
    closeExpiredSessions,
    shutdownSessions,
  } as const
}
