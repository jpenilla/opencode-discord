import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { Deferred, Effect, Fiber, Ref } from "effect";

import type { SessionHandle } from "@/opencode/service.ts";
import { createSessionRegistry, type SessionRegistryState } from "@/sessions/session-runtime.ts";
import type { ActiveRun } from "@/sessions/session.ts";
import type { PersistedChannelSettings } from "@/state/channel-settings.ts";
import type { PersistedChannelSession } from "@/state/persistence.ts";
import { sessionPathsFromRoot } from "@/state/paths.ts";
import { makeMessage, makeSilentLogger } from "../support/fixtures.ts";
import { failTest } from "../support/errors.ts";
import { appendRef, runTestEffect } from "../support/runtime.ts";
import { unsafeStub } from "../support/stub.ts";

const makeRegistryMessage = (channelId = "channel-1") =>
  makeMessage({
    id: `message-${channelId}`,
    channelId,
    guildId: "guild-1",
    guild: { name: "Guild One" },
    channel: {
      type: ChannelType.GuildText,
      name: "general",
      topic: "Work thread",
    },
    inGuild: () => true,
  });

const makeHandle = (
  sessionId: string,
  workdir: string,
  onClose: (sessionId: string) => void,
): SessionHandle =>
  unsafeStub<SessionHandle>({
    sessionId,
    client: {},
    workdir,
    backend: "bwrap",
    close: () => Effect.sync(() => onClose(sessionId)),
  });

const makeActiveRun = () => unsafeStub<ActiveRun>({});

const makeState = (): SessionRegistryState => ({
  sessionsByChannelId: new Map(),
  sessionsBySessionId: new Map(),
  activeRunsBySessionId: new Map(),
});

const logger = makeSilentLogger();

const runEffect = runTestEffect;
const makeRef = <A>(value: A) => runEffect(Ref.make(value));
const updateMapRef = <K, V>(ref: Ref.Ref<Map<K, V>>, update: (current: Map<K, V>) => void) =>
  Ref.update(ref, (current) => {
    const next = new Map(current);
    update(next);
    return next;
  });
const appendClosed = (closed: Ref.Ref<string[]>, sessionId: string) => {
  Effect.runSync(appendRef(closed, sessionId));
};

const makeHarness = async (options?: {
  createOpencodeSession?: (input: {
    workdir: string;
    title: string;
    systemPromptAppend?: string;
  }) => Effect.Effect<SessionHandle, unknown>;
  isSessionHealthy?: (session: SessionHandle) => Effect.Effect<boolean>;
  isSessionBusy?: (sessionId: string) => Effect.Effect<boolean>;
  getPersistedChannelSettings?: (
    channelId: string,
  ) => Effect.Effect<PersistedChannelSettings | null, unknown>;
}) => {
  const stateRef = await makeRef(makeState());
  const created = await makeRef<
    Array<{ workdir: string; title: string; systemPromptAppend?: string }>
  >([]);
  const started = await makeRef<string[]>([]);
  const removedRoots = await makeRef<string[]>([]);
  const closed = await makeRef<string[]>([]);
  const nextRoot = await makeRef(0);
  const nextSession = await makeRef(0);
  const persisted = await makeRef<Map<string, PersistedChannelSession>>(new Map());
  const persistedSettings = await makeRef<Map<string, PersistedChannelSettings>>(new Map());

  const createSessionPaths = (_channelId: string) =>
    Ref.modify(nextRoot, (current): readonly [PersistedChannelSession["rootDir"], number] => {
      const index = current + 1;
      const rootDir = `/tmp/session-root-${index}`;
      return [rootDir, index];
    }).pipe(Effect.map((rootDir) => sessionPathsFromRoot(rootDir)));

  const defaultCreateOpencodeSession = ({
    workdir,
    title,
    systemPromptAppend,
  }: {
    workdir: string;
    title: string;
    systemPromptAppend?: string;
  }) =>
    Effect.gen(function* () {
      yield* appendRef(created, { workdir, title, systemPromptAppend });
      const index = yield* Ref.modify(nextSession, (current): readonly [number, number] => {
        const next = current + 1;
        return [next, next];
      });
      return makeHandle(`session-${index}`, workdir, (sessionId) =>
        appendClosed(closed, sessionId),
      );
    });

  const lifecycle = createSessionRegistry({
    stateRef,
    createOpencodeSession: (workdir, title, systemPromptAppend) =>
      (options?.createOpencodeSession ?? defaultCreateOpencodeSession)({
        workdir,
        title,
        systemPromptAppend,
      }),
    attachOpencodeSession: (workdir, sessionId) =>
      Effect.succeed(
        makeHandle(sessionId, workdir, (closedSessionId) => appendClosed(closed, closedSessionId)),
      ),
    getPersistedSession: (channelId) =>
      Ref.get(persisted).pipe(Effect.map((current) => current.get(channelId) ?? null)),
    upsertPersistedSession: (session) =>
      updateMapRef(persisted, (current) => current.set(session.channelId, session)),
    getPersistedChannelSettings:
      options?.getPersistedChannelSettings ??
      ((channelId) =>
        Ref.get(persistedSettings).pipe(Effect.map((current) => current.get(channelId) ?? null))),
    touchPersistedSession: (channelId, lastActivityAt) =>
      updateMapRef(persisted, (current) => {
        const session = current.get(channelId);
        if (session) {
          current.set(channelId, { ...session, lastActivityAt });
        }
      }),
    deletePersistedSession: (channelId) =>
      updateMapRef(persisted, (current) => current.delete(channelId)),
    isSessionHealthy: options?.isSessionHealthy ?? (() => Effect.succeed(true)),
    startWorker: (session) => appendRef(started, session.opencode.sessionId),
    logger,
    sessionInstructions: "",
    triggerPhrase: "hey opencode",
    channelSettingsDefaults: {
      showThinking: true,
      showCompactionSummaries: true,
    },
    isSessionBusy: (session) =>
      options?.isSessionBusy
        ? options.isSessionBusy(session.opencode.sessionId)
        : Effect.succeed(false),
    idleTimeoutMs: 30 * 60 * 1_000,
    createSessionPaths,
    deleteSessionRoot: (rootDir) => appendRef(removedRoots, rootDir),
  });

  return {
    lifecycle,
    stateRef,
    created,
    started,
    removedRoots,
    closed,
    persisted,
  };
};

describe("createSessionRegistry", () => {
  test("single-flights concurrent cold starts for the same channel", async () => {
    const createStarted = await runEffect(Deferred.make<void>());
    const releaseCreate = await runEffect(Deferred.make<void>());
    const created = await runEffect(Ref.make(0));
    const closed = await runEffect(Ref.make<string[]>([]));

    const { lifecycle } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          const count = yield* Ref.modify(created, (current): readonly [number, number] => {
            const next = current + 1;
            return [next, next];
          });
          yield* Deferred.succeed(createStarted, undefined).pipe(Effect.ignore);
          yield* Deferred.await(releaseCreate);
          return makeHandle(`session-${count}`, workdir, (sessionId) => {
            Effect.runSync(appendRef(closed, sessionId));
          });
        }),
    });
    const message = makeRegistryMessage("channel-1");

    const [first, second] = await runEffect(
      Effect.gen(function* () {
        const fiber1 = yield* Effect.forkChild(lifecycle.createOrGetSession(message));
        yield* Deferred.await(createStarted);
        const fiber2 = yield* Effect.forkChild(lifecycle.createOrGetSession(message));
        yield* Deferred.succeed(releaseCreate, undefined).pipe(Effect.ignore);
        return yield* Effect.all([Fiber.join(fiber1), Fiber.join(fiber2)]);
      }),
    );

    expect(first).toBe(second);
    expect(first.opencode.sessionId).toBe("session-1");
    expect(await runEffect(Ref.get(created))).toBe(1);
  });

  test("clears the gate after a failed cold start so a waiting retry can succeed", async () => {
    const createStarted = await runEffect(Deferred.make<void>());
    const releaseCreate = await runEffect(Deferred.make<void>());
    const createCount = await runEffect(Ref.make(0));
    const { lifecycle, started, removedRoots } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          const count = yield* Ref.modify(createCount, (current): readonly [number, number] => {
            const next = current + 1;
            return [next, next];
          });
          yield* Deferred.succeed(createStarted, undefined).pipe(Effect.ignore);
          yield* Deferred.await(releaseCreate);
          if (count === 1) {
            return yield* failTest("create failed");
          }
          return makeHandle(`session-${count}`, workdir, () => {});
        }),
    });
    const message = makeRegistryMessage("channel-retry");

    const exits = await runEffect(
      Effect.gen(function* () {
        const fiber1 = yield* Effect.forkChild(Effect.exit(lifecycle.createOrGetSession(message)), {
          startImmediately: true,
        });
        yield* Deferred.await(createStarted);
        const fiber2 = yield* Effect.forkChild(Effect.exit(lifecycle.createOrGetSession(message)), {
          startImmediately: true,
        });
        yield* Deferred.succeed(releaseCreate, undefined).pipe(Effect.ignore);
        return yield* Effect.all([Fiber.join(fiber1), Fiber.join(fiber2)]);
      }),
    );

    expect(exits.map((exit) => exit._tag)).toEqual(["Failure", "Success"]);
    expect(await runEffect(Ref.get(removedRoots))).toEqual(["/tmp/session-root-1"]);
    const succeeded = exits.find((exit) => exit._tag === "Success");
    expect(succeeded?._tag).toBe("Success");
    expect(
      succeeded && succeeded._tag === "Success" ? succeeded.value.opencode.sessionId : null,
    ).toBe("session-2");
    expect(await runEffect(Ref.get(started))).toEqual(["session-2"]);
  });

  test("cleans the new session root when setup fails before activation", async () => {
    const { lifecycle, removedRoots, started } = await makeHarness({
      getPersistedChannelSettings: () => Effect.fail(new Error("settings unavailable")),
    });

    await expect(
      runEffect(lifecycle.createOrGetSession(makeRegistryMessage("channel-fail"))),
    ).rejects.toThrow("settings unavailable");

    expect(await runEffect(Ref.get(removedRoots))).toEqual(["/tmp/session-root-1"]);
    expect(await runEffect(Ref.get(started))).toEqual([]);
  });

  test("bypasses health checks for busy sessions by default", async () => {
    const healthChecks = await runEffect(Ref.make<string[]>([]));
    const { lifecycle } = await makeHarness({
      isSessionHealthy: (session) =>
        appendRef(healthChecks, session.sessionId).pipe(Effect.as(true)),
    });
    const message = makeRegistryMessage("channel-busy");
    const session = await runEffect(lifecycle.createOrGetSession(message));
    session.activeRun = makeActiveRun();

    const result = await runEffect(lifecycle.ensureSessionHealth(session, message, "busy"));

    expect(result).toBe(session);
    expect(await runEffect(Ref.get(healthChecks))).toEqual([]);
  });

  test("single-flights recovery and rekeys session indexes", async () => {
    const recreateStarted = await runEffect(Deferred.make<void>());
    const releaseRecreate = await runEffect(Deferred.make<void>());
    const createCount = await runEffect(Ref.make(0));
    const closed = await runEffect(Ref.make<string[]>([]));

    const { lifecycle } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          const count = yield* Ref.modify(createCount, (current): readonly [number, number] => {
            const next = current + 1;
            return [next, next];
          });
          if (count === 2) {
            yield* Deferred.succeed(recreateStarted, undefined).pipe(Effect.ignore);
            yield* Deferred.await(releaseRecreate);
          }
          return makeHandle(`session-${count}`, workdir, (sessionId) => {
            Effect.runSync(appendRef(closed, sessionId));
          });
        }),
      isSessionHealthy: (session) => Effect.succeed(session.sessionId !== "session-1"),
    });

    const message = makeRegistryMessage("channel-recover");
    const session = await runEffect(lifecycle.createOrGetSession(message));
    const previousSessionId = session.opencode.sessionId;
    await runEffect(lifecycle.setActiveRun(session, makeActiveRun()));

    const [first, second] = await runEffect(
      Effect.gen(function* () {
        const fiber1 = yield* Effect.forkChild(
          lifecycle.ensureSessionHealth(session, message, "recover", false),
        );
        yield* Deferred.await(recreateStarted);
        const fiber2 = yield* Effect.forkChild(
          lifecycle.ensureSessionHealth(session, message, "recover", false),
        );
        yield* Deferred.succeed(releaseRecreate, undefined).pipe(Effect.ignore);
        return yield* Effect.all([Fiber.join(fiber1), Fiber.join(fiber2)]);
      }),
    );

    expect(first).toBe(session);
    expect(second).toBe(session);
    expect(session.opencode.sessionId).toBe("session-2");
    expect(await runEffect(Ref.get(createCount))).toBe(2);
    expect(await runEffect(lifecycle.getSession(message.channelId))).toBe(session);
    expect(await runEffect(lifecycle.getSessionContext(previousSessionId))).toBeNull();
    expect(await runEffect(lifecycle.getSessionContext(session.opencode.sessionId))).toEqual({
      session,
      activeRun: null,
    });
    expect(await runEffect(lifecycle.getActiveRunBySessionId(previousSessionId))).toBeNull();
    expect(await runEffect(Ref.get(closed))).toEqual(["session-1"]);
  });

  test("shuts down sessions, closes handles, and keeps persistent session roots", async () => {
    const { lifecycle, closed, removedRoots } = await makeHarness();

    await runEffect(lifecycle.createOrGetSession(makeRegistryMessage("channel-1")));
    await runEffect(lifecycle.createOrGetSession(makeRegistryMessage("channel-2")));
    await runEffect(lifecycle.shutdownSessions());

    expect(await runEffect(Ref.get(closed))).toEqual(["session-1", "session-2"]);
    expect(await runEffect(Ref.get(removedRoots))).toEqual([]);
  });

  test("invalidates the loaded session without deleting the session root", async () => {
    const { lifecycle, closed, removedRoots, persisted } = await makeHarness();
    const message = makeRegistryMessage("channel-1");
    const session = await runEffect(lifecycle.createOrGetSession(message));

    expect(
      await runEffect(lifecycle.invalidateSession("channel-1", "user requested /new-session")),
    ).toBe(true);

    expect(await runEffect(Ref.get(closed))).toEqual([session.opencode.sessionId]);
    expect(await runEffect(lifecycle.getSession("channel-1"))).toBeUndefined();
    expect(await runEffect(Ref.get(persisted))).toEqual(new Map());
    expect(await runEffect(Ref.get(removedRoots))).toEqual([]);
  });

  test("invalidates a session that was still being created", async () => {
    const createStarted = await runEffect(Deferred.make<void>());
    const releaseCreate = await runEffect(Deferred.make<void>());
    const { lifecycle, closed, persisted } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(createStarted, undefined).pipe(Effect.ignore);
          yield* Deferred.await(releaseCreate);
          return makeHandle("session-race", workdir, (sessionId) => {
            Effect.runSync(appendRef(closed, sessionId));
          });
        }),
    });
    const message = makeRegistryMessage("channel-race");

    const [created, invalidated] = await runEffect(
      Effect.gen(function* () {
        const createFiber = yield* Effect.forkChild(lifecycle.createOrGetSession(message));
        yield* Deferred.await(createStarted);
        const invalidateFiber = yield* Effect.forkChild(
          lifecycle.invalidateSession("channel-race", "user requested /new-session"),
        );
        yield* Deferred.succeed(releaseCreate, undefined).pipe(Effect.ignore);
        return yield* Effect.all([Fiber.join(createFiber), Fiber.join(invalidateFiber)]);
      }),
    );

    expect(created.opencode.sessionId).toBe("session-race");
    expect(invalidated).toBe(true);
    expect(await runEffect(lifecycle.getSession("channel-race"))).toBeUndefined();
    expect(await runEffect(Ref.get(persisted))).toEqual(new Map());
    expect(await runEffect(Ref.get(closed))).toEqual(["session-race"]);
  });

  test("does not invalidate a loaded session while it is busy", async () => {
    const { lifecycle, closed, persisted } = await makeHarness({
      isSessionBusy: () => Effect.succeed(true),
    });
    const message = makeRegistryMessage("channel-1");
    const session = await runEffect(lifecycle.createOrGetSession(message));

    expect(
      await runEffect(lifecycle.invalidateSession("channel-1", "user requested /new-session")),
    ).toBe(false);

    expect(await runEffect(Ref.get(closed))).toEqual([]);
    expect(await runEffect(lifecycle.getSession("channel-1"))).toBe(session);
    expect(await runEffect(Ref.get(persisted))).toEqual(
      new Map([
        [
          "channel-1",
          {
            channelId: "channel-1",
            opencodeSessionId: session.opencode.sessionId,
            rootDir: session.rootDir,
            systemPromptAppend: session.systemPromptAppend,
            createdAt: session.createdAt,
            lastActivityAt: session.lastActivityAt,
          },
        ],
      ]),
    );
  });

  test("does not close idle sessions while an external busy callback reports active work", async () => {
    const { lifecycle, closed } = await makeHarness({
      isSessionBusy: () => Effect.succeed(true),
    });

    const session = await runEffect(lifecycle.createOrGetSession(makeRegistryMessage("channel-1")));
    session.lastActivityAt = 0;

    await runEffect(lifecycle.closeExpiredSessions(30 * 60 * 1_000 + 1));

    expect(await runEffect(Ref.get(closed))).toEqual([]);
    expect(await runEffect(lifecycle.getSession(session.channelId))).toBe(session);
  });
});
