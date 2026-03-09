import { describe, expect, test } from "bun:test"
import { ChannelType, type Message } from "discord.js"
import { Deferred, Effect, Fiber, Ref } from "effect"

import type { SessionHandle } from "@/opencode/service.ts"
import { createSessionLifecycle, type SessionLifecycleState } from "@/sessions/session-lifecycle.ts"
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts"
import type { PersistedChannelSession } from "@/state/store.ts"
import { unsafeStub } from "../support/stub.ts"

const makeMessage = (channelId = "channel-1") =>
  unsafeStub<Message>({
    channelId,
    guildId: "guild-1",
    guild: { name: "Guild One" },
    channel: {
      type: ChannelType.GuildText,
      name: "general",
      topic: "Work thread",
    },
    inGuild: () => true,
  })

const makeHandle = (sessionId: string, workdir: string, onClose: (sessionId: string) => void): SessionHandle =>
  unsafeStub<SessionHandle>({
    sessionId,
    client: {},
    workdir,
    backend: "bwrap",
    close: () => Effect.sync(() => onClose(sessionId)),
  })

const makeActiveRun = () => unsafeStub<ActiveRun>({})
const makeCardMessage = (id: string) => unsafeStub<Message>({ id })

const makeState = (): SessionLifecycleState => ({
  sessionsByChannelId: new Map(),
  sessionsBySessionId: new Map(),
  activeRunsBySessionId: new Map(),
  gatesByChannelId: new Map(),
  idleCompactionsBySessionId: new Map(),
})

const logger = {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
} as const

const makeHarness = async (options?: {
  createOpencodeSession?: (input: {
    workdir: string
    title: string
    systemPromptAppend?: string
  }) => Effect.Effect<SessionHandle, unknown>
  isSessionHealthy?: (session: SessionHandle) => Effect.Effect<boolean>
}) => {
  const stateRef = await Effect.runPromise(Ref.make(makeState()))
  const created = await Effect.runPromise(
    Ref.make<Array<{ workdir: string; title: string; systemPromptAppend?: string }>>([]),
  )
  const started = await Effect.runPromise(Ref.make<string[]>([]))
  const removedRoots = await Effect.runPromise(Ref.make<string[]>([]))
  const closed = await Effect.runPromise(Ref.make<string[]>([]))
  const nextRoot = await Effect.runPromise(Ref.make(0))
  const nextSession = await Effect.runPromise(Ref.make(0))
  const persisted = await Effect.runPromise(Ref.make<Map<string, PersistedChannelSession>>(new Map()))

  const createSessionPaths = (_channelId: string) =>
    Ref.modify(nextRoot, (current): readonly [ReturnType<typeof Effect.succeed> extends never ? never : { rootDir: string; workdir: string }, number] => {
      const index = current + 1
      const rootDir = `/tmp/session-root-${index}`
      return [
        {
          rootDir,
          workdir: `${rootDir}/home/workspace`,
        },
        index,
      ]
    }).pipe(Effect.flatMap((paths) => Effect.succeed(paths)))

  const defaultCreateOpencodeSession = ({
    workdir,
    title,
    systemPromptAppend,
  }: {
    workdir: string
    title: string
    systemPromptAppend?: string
  }) =>
    Effect.gen(function* () {
      yield* Ref.update(created, (current) => [...current, { workdir, title, systemPromptAppend }])
      const index = yield* Ref.modify(nextSession, (current): readonly [number, number] => {
        const next = current + 1
        return [next, next]
      })
      return makeHandle(`session-${index}`, workdir, (sessionId) => {
        Effect.runSync(Ref.update(closed, (current) => [...current, sessionId]))
      })
    })

  const lifecycle = createSessionLifecycle({
    stateRef,
    createOpencodeSession: (workdir, title, systemPromptAppend) =>
      (options?.createOpencodeSession ?? defaultCreateOpencodeSession)({
        workdir,
        title,
        systemPromptAppend,
      }),
    attachOpencodeSession: (workdir, sessionId) =>
      Effect.succeed(makeHandle(sessionId, workdir, (closedSessionId) => {
        Effect.runSync(Ref.update(closed, (current) => [...current, closedSessionId]))
      })),
    getPersistedSession: (channelId) =>
      Ref.get(persisted).pipe(Effect.map((current) => current.get(channelId) ?? null)),
    upsertPersistedSession: (session) =>
      Ref.update(persisted, (current) => {
        const next = new Map(current)
        next.set(session.channelId, session)
        return next
      }),
    touchPersistedSession: (channelId, lastActivityAt) =>
      Ref.update(persisted, (current) => {
        const next = new Map(current)
        const session = next.get(channelId)
        if (session) {
          next.set(channelId, { ...session, lastActivityAt })
        }
        return next
      }),
    deletePersistedSession: (channelId) =>
      Ref.update(persisted, (current) => {
        const next = new Map(current)
        next.delete(channelId)
        return next
      }),
    isSessionHealthy: options?.isSessionHealthy ?? (() => Effect.succeed(true)),
    startWorker: (session) => Ref.update(started, (current) => [...current, session.opencode.sessionId]),
    logger,
    sessionInstructions: "",
    triggerPhrase: "hey opencode",
    idleTimeoutMs: 30 * 60 * 1_000,
    sessionsRootDir: "/tmp/sessions",
    createSessionPaths,
    deleteSessionRoot: (rootDir) => Ref.update(removedRoots, (current) => [...current, rootDir]),
  })

  return {
    lifecycle,
    stateRef,
    created,
    started,
    removedRoots,
    closed,
  }
}

describe("createSessionLifecycle", () => {
  test("single-flights concurrent cold starts for the same channel", async () => {
    const createStarted = await Effect.runPromise(Deferred.make<void>())
    const releaseCreate = await Effect.runPromise(Deferred.make<void>())
    const created = await Effect.runPromise(Ref.make(0))
    const closed = await Effect.runPromise(Ref.make<string[]>([]))

    const { lifecycle } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          const count = yield* Ref.modify(created, (current): readonly [number, number] => {
            const next = current + 1
            return [next, next]
          })
          yield* Deferred.succeed(createStarted, undefined).pipe(Effect.ignore)
          yield* Deferred.await(releaseCreate)
          return makeHandle(`session-${count}`, workdir, (sessionId) => {
            Effect.runSync(Ref.update(closed, (current) => [...current, sessionId]))
          })
        }),
    })
    const message = makeMessage("channel-1")

    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber1 = yield* Effect.fork(lifecycle.createOrGetSession(message))
        yield* Deferred.await(createStarted)
        const fiber2 = yield* Effect.fork(lifecycle.createOrGetSession(message))
        yield* Deferred.succeed(releaseCreate, undefined).pipe(Effect.ignore)
        return yield* Effect.all([Fiber.join(fiber1), Fiber.join(fiber2)])
      }),
    )

    expect(first).toBe(second)
    expect(first.opencode.sessionId).toBe("session-1")
    expect(await Effect.runPromise(Ref.get(created))).toBe(1)
  })

  test("clears the gate after a failed cold start so a later retry can succeed", async () => {
    const createStarted = await Effect.runPromise(Deferred.make<void>())
    const releaseCreate = await Effect.runPromise(Deferred.make<void>())
    const createCount = await Effect.runPromise(Ref.make(0))
    const { lifecycle, started, removedRoots } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          const count = yield* Ref.modify(createCount, (current): readonly [number, number] => {
            const next = current + 1
            return [next, next]
          })
          yield* Deferred.succeed(createStarted, undefined).pipe(Effect.ignore)
          yield* Deferred.await(releaseCreate)
          if (count === 1) {
            return yield* Effect.fail(new Error("create failed"))
          }
          return makeHandle(`session-${count}`, workdir, () => {})
        }),
    })
    const message = makeMessage("channel-retry")

    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber1 = yield* Effect.fork(Effect.exit(lifecycle.createOrGetSession(message)))
        yield* Deferred.await(createStarted)
        const fiber2 = yield* Effect.fork(Effect.exit(lifecycle.createOrGetSession(message)))
        yield* Deferred.succeed(releaseCreate, undefined).pipe(Effect.ignore)
        return yield* Effect.all([Fiber.join(fiber1), Fiber.join(fiber2)])
      }),
    )

    expect(exits.map((exit) => exit._tag)).toEqual(["Failure", "Failure"])
    expect(await Effect.runPromise(Ref.get(removedRoots))).toEqual(["/tmp/session-root-1"])

    const retried = await Effect.runPromise(lifecycle.createOrGetSession(message))
    expect(retried.opencode.sessionId).toBe("session-2")
    expect(await Effect.runPromise(Ref.get(started))).toEqual(["session-2"])
  })

  test("bypasses health checks for busy sessions by default", async () => {
    const healthChecks = await Effect.runPromise(Ref.make<string[]>([]))
    const { lifecycle } = await makeHarness({
      isSessionHealthy: (session) =>
        Ref.update(healthChecks, (current) => [...current, session.sessionId]).pipe(Effect.as(true)),
    })
    const message = makeMessage("channel-busy")
    const session = await Effect.runPromise(lifecycle.createOrGetSession(message))
    session.activeRun = makeActiveRun()

    const result = await Effect.runPromise(lifecycle.ensureSessionHealth(session, message, "busy"))

    expect(result).toBe(session)
    expect(await Effect.runPromise(Ref.get(healthChecks))).toEqual([])
  })

  test("single-flights recovery, rekeys session indexes, and moves idle compaction cards", async () => {
    const recreateStarted = await Effect.runPromise(Deferred.make<void>())
    const releaseRecreate = await Effect.runPromise(Deferred.make<void>())
    const createCount = await Effect.runPromise(Ref.make(0))
    const closed = await Effect.runPromise(Ref.make<string[]>([]))

    const { lifecycle } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          const count = yield* Ref.modify(createCount, (current): readonly [number, number] => {
            const next = current + 1
            return [next, next]
          })
          if (count === 2) {
            yield* Deferred.succeed(recreateStarted, undefined).pipe(Effect.ignore)
            yield* Deferred.await(releaseRecreate)
          }
          return makeHandle(`session-${count}`, workdir, (sessionId) => {
            Effect.runSync(Ref.update(closed, (current) => [...current, sessionId]))
          })
        }),
      isSessionHealthy: (session) => Effect.succeed(session.sessionId !== "session-1"),
    })

    const message = makeMessage("channel-recover")
    const session = await Effect.runPromise(lifecycle.createOrGetSession(message))
    const previousSessionId = session.opencode.sessionId
    const card = makeCardMessage("card-1")

    await Effect.runPromise(lifecycle.setIdleCompactionCard(previousSessionId, card))
    await Effect.runPromise(lifecycle.setActiveRun(session, makeActiveRun()))

    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber1 = yield* Effect.fork(lifecycle.ensureSessionHealth(session, message, "recover", false))
        yield* Deferred.await(recreateStarted)
        const fiber2 = yield* Effect.fork(lifecycle.ensureSessionHealth(session, message, "recover", false))
        yield* Deferred.succeed(releaseRecreate, undefined).pipe(Effect.ignore)
        return yield* Effect.all([Fiber.join(fiber1), Fiber.join(fiber2)])
      }),
    )

    expect(first).toBe(session)
    expect(second).toBe(session)
    expect(session.opencode.sessionId).toBe("session-2")
    expect(await Effect.runPromise(Ref.get(createCount))).toBe(2)
    expect(await Effect.runPromise(lifecycle.getSession(message.channelId))).toBe(session)
    expect(await Effect.runPromise(lifecycle.getSessionContext(previousSessionId))).toBeNull()
    expect(await Effect.runPromise(lifecycle.getSessionContext(session.opencode.sessionId))).toEqual({
      session,
      activeRun: null,
    })
    expect(await Effect.runPromise(lifecycle.getIdleCompactionCard(previousSessionId))).toBeNull()
    expect(await Effect.runPromise(lifecycle.getIdleCompactionCard(session.opencode.sessionId))).toBe(card)
    expect(await Effect.runPromise(lifecycle.getActiveRunBySessionId(previousSessionId))).toBeNull()
    expect(await Effect.runPromise(Ref.get(closed))).toEqual(["session-1"])
  })

  test("shuts down sessions, closes handles, and keeps persistent session roots", async () => {
    const { lifecycle, closed, removedRoots } = await makeHarness()

    await Effect.runPromise(lifecycle.createOrGetSession(makeMessage("channel-1")))
    await Effect.runPromise(lifecycle.createOrGetSession(makeMessage("channel-2")))
    await Effect.runPromise(lifecycle.shutdownSessions())

    expect(await Effect.runPromise(Ref.get(closed))).toEqual(["session-1", "session-2"])
    expect(await Effect.runPromise(Ref.get(removedRoots))).toEqual([])
  })

  test("does not close idle sessions while an idle compaction card is active", async () => {
    const { lifecycle, closed } = await makeHarness()

    const session = await Effect.runPromise(lifecycle.createOrGetSession(makeMessage("channel-1")))
    session.lastActivityAt = 0
    await Effect.runPromise(lifecycle.setIdleCompactionCard(session.opencode.sessionId, makeCardMessage("card-1")))

    await Effect.runPromise(lifecycle.closeExpiredSessions(30 * 60 * 1_000 + 1))

    expect(await Effect.runPromise(Ref.get(closed))).toEqual([])
    expect(await Effect.runPromise(lifecycle.getSession(session.channelId))).toBe(session)
  })
})
