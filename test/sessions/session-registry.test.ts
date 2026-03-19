import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { Deferred, Effect, Fiber, Ref } from "effect";

import type { SessionHandle } from "@/opencode/service.ts";
import { createSessionRegistry, type SessionRegistryState } from "@/sessions/session-runtime.ts";
import type { ActiveRun } from "@/sessions/session.ts";
import type { PersistedChannelSettings } from "@/state/channel-settings.ts";
import type { PersistedChannelSession } from "@/state/persistence.ts";
import { makeMessage, makeSilentLogger } from "../support/fixtures.ts";
import { failTest } from "../support/errors.ts";
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

const makeHarness = async (options?: {
  createOpencodeSession?: (input: {
    workdir: string;
    title: string;
    systemPromptAppend?: string;
  }) => Effect.Effect<SessionHandle, unknown>;
  isSessionHealthy?: (session: SessionHandle) => Effect.Effect<boolean>;
  isSessionBusy?: (sessionId: string) => Effect.Effect<boolean>;
}) => {
  const stateRef = await Effect.runPromise(Ref.make(makeState()));
  const created = await Effect.runPromise(
    Ref.make<Array<{ workdir: string; title: string; systemPromptAppend?: string }>>([]),
  );
  const started = await Effect.runPromise(Ref.make<string[]>([]));
  const removedRoots = await Effect.runPromise(Ref.make<string[]>([]));
  const closed = await Effect.runPromise(Ref.make<string[]>([]));
  const nextRoot = await Effect.runPromise(Ref.make(0));
  const nextSession = await Effect.runPromise(Ref.make(0));
  const persisted = await Effect.runPromise(
    Ref.make<Map<string, PersistedChannelSession>>(new Map()),
  );
  const persistedSettings = await Effect.runPromise(
    Ref.make<Map<string, PersistedChannelSettings>>(new Map()),
  );

  const createSessionPaths = (_channelId: string) =>
    Ref.modify(
      nextRoot,
      (
        current,
      ): readonly [
        ReturnType<typeof Effect.succeed> extends never
          ? never
          : { rootDir: string; workdir: string },
        number,
      ] => {
        const index = current + 1;
        const rootDir = `/tmp/session-root-${index}`;
        return [
          {
            rootDir,
            workdir: `${rootDir}/home/workspace`,
          },
          index,
        ];
      },
    ).pipe(Effect.flatMap((paths) => Effect.succeed(paths)));

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
      yield* Ref.update(created, (current) => [...current, { workdir, title, systemPromptAppend }]);
      const index = yield* Ref.modify(nextSession, (current): readonly [number, number] => {
        const next = current + 1;
        return [next, next];
      });
      return makeHandle(`session-${index}`, workdir, (sessionId) => {
        Effect.runSync(Ref.update(closed, (current) => [...current, sessionId]));
      });
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
        makeHandle(sessionId, workdir, (closedSessionId) => {
          Effect.runSync(Ref.update(closed, (current) => [...current, closedSessionId]));
        }),
      ),
    getPersistedSession: (channelId) =>
      Ref.get(persisted).pipe(Effect.map((current) => current.get(channelId) ?? null)),
    upsertPersistedSession: (session) =>
      Ref.update(persisted, (current) => {
        const next = new Map(current);
        next.set(session.channelId, session);
        return next;
      }),
    getPersistedChannelSettings: (channelId) =>
      Ref.get(persistedSettings).pipe(Effect.map((current) => current.get(channelId) ?? null)),
    touchPersistedSession: (channelId, lastActivityAt) =>
      Ref.update(persisted, (current) => {
        const next = new Map(current);
        const session = next.get(channelId);
        if (session) {
          next.set(channelId, { ...session, lastActivityAt });
        }
        return next;
      }),
    deletePersistedSession: (channelId) =>
      Ref.update(persisted, (current) => {
        const next = new Map(current);
        next.delete(channelId);
        return next;
      }),
    isSessionHealthy: options?.isSessionHealthy ?? (() => Effect.succeed(true)),
    startWorker: (session) =>
      Ref.update(started, (current) => [...current, session.opencode.sessionId]),
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
    sessionsRootDir: "/tmp/sessions",
    createSessionPaths,
    deleteSessionRoot: (rootDir) => Ref.update(removedRoots, (current) => [...current, rootDir]),
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
    const createStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseCreate = await Effect.runPromise(Deferred.make<void>());
    const created = await Effect.runPromise(Ref.make(0));
    const closed = await Effect.runPromise(Ref.make<string[]>([]));

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
            Effect.runSync(Ref.update(closed, (current) => [...current, sessionId]));
          });
        }),
    });
    const message = makeRegistryMessage("channel-1");

    const [first, second] = await Effect.runPromise(
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
    expect(await Effect.runPromise(Ref.get(created))).toBe(1);
  });

  test("clears the gate after a failed cold start so a waiting retry can succeed", async () => {
    const createStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseCreate = await Effect.runPromise(Deferred.make<void>());
    const createCount = await Effect.runPromise(Ref.make(0));
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

    const exits = await Effect.runPromise(
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
    expect(await Effect.runPromise(Ref.get(removedRoots))).toEqual(["/tmp/session-root-1"]);
    const succeeded = exits.find((exit) => exit._tag === "Success");
    expect(succeeded?._tag).toBe("Success");
    expect(
      succeeded && succeeded._tag === "Success" ? succeeded.value.opencode.sessionId : null,
    ).toBe("session-2");
    expect(await Effect.runPromise(Ref.get(started))).toEqual(["session-2"]);
  });

  test("bypasses health checks for busy sessions by default", async () => {
    const healthChecks = await Effect.runPromise(Ref.make<string[]>([]));
    const { lifecycle } = await makeHarness({
      isSessionHealthy: (session) =>
        Ref.update(healthChecks, (current) => [...current, session.sessionId]).pipe(
          Effect.as(true),
        ),
    });
    const message = makeRegistryMessage("channel-busy");
    const session = await Effect.runPromise(lifecycle.createOrGetSession(message));
    session.activeRun = makeActiveRun();

    const result = await Effect.runPromise(lifecycle.ensureSessionHealth(session, message, "busy"));

    expect(result).toBe(session);
    expect(await Effect.runPromise(Ref.get(healthChecks))).toEqual([]);
  });

  test("single-flights recovery and rekeys session indexes", async () => {
    const recreateStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseRecreate = await Effect.runPromise(Deferred.make<void>());
    const createCount = await Effect.runPromise(Ref.make(0));
    const closed = await Effect.runPromise(Ref.make<string[]>([]));

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
            Effect.runSync(Ref.update(closed, (current) => [...current, sessionId]));
          });
        }),
      isSessionHealthy: (session) => Effect.succeed(session.sessionId !== "session-1"),
    });

    const message = makeRegistryMessage("channel-recover");
    const session = await Effect.runPromise(lifecycle.createOrGetSession(message));
    const previousSessionId = session.opencode.sessionId;
    await Effect.runPromise(lifecycle.setActiveRun(session, makeActiveRun()));

    const [first, second] = await Effect.runPromise(
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
    expect(await Effect.runPromise(Ref.get(createCount))).toBe(2);
    expect(await Effect.runPromise(lifecycle.getSession(message.channelId))).toBe(session);
    expect(await Effect.runPromise(lifecycle.getSessionContext(previousSessionId))).toBeNull();
    expect(
      await Effect.runPromise(lifecycle.getSessionContext(session.opencode.sessionId)),
    ).toEqual({
      session,
      activeRun: null,
    });
    expect(
      await Effect.runPromise(lifecycle.getActiveRunBySessionId(previousSessionId)),
    ).toBeNull();
    expect(await Effect.runPromise(Ref.get(closed))).toEqual(["session-1"]);
  });

  test("shuts down sessions, closes handles, and keeps persistent session roots", async () => {
    const { lifecycle, closed, removedRoots } = await makeHarness();

    await Effect.runPromise(lifecycle.createOrGetSession(makeRegistryMessage("channel-1")));
    await Effect.runPromise(lifecycle.createOrGetSession(makeRegistryMessage("channel-2")));
    await Effect.runPromise(lifecycle.shutdownSessions());

    expect(await Effect.runPromise(Ref.get(closed))).toEqual(["session-1", "session-2"]);
    expect(await Effect.runPromise(Ref.get(removedRoots))).toEqual([]);
  });

  test("invalidates the loaded session without deleting the session root", async () => {
    const { lifecycle, closed, removedRoots, persisted } = await makeHarness();
    const message = makeRegistryMessage("channel-1");
    const session = await Effect.runPromise(lifecycle.createOrGetSession(message));

    expect(
      await Effect.runPromise(
        lifecycle.invalidateSession("channel-1", "user requested /new-session"),
      ),
    ).toBe(true);

    expect(await Effect.runPromise(Ref.get(closed))).toEqual([session.opencode.sessionId]);
    expect(await Effect.runPromise(lifecycle.getSession("channel-1"))).toBeUndefined();
    expect(await Effect.runPromise(Ref.get(persisted))).toEqual(new Map());
    expect(await Effect.runPromise(Ref.get(removedRoots))).toEqual([]);
  });

  test("invalidates a session that was still being created", async () => {
    const createStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseCreate = await Effect.runPromise(Deferred.make<void>());
    const { lifecycle, closed, persisted } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(createStarted, undefined).pipe(Effect.ignore);
          yield* Deferred.await(releaseCreate);
          return makeHandle("session-race", workdir, (sessionId) => {
            Effect.runSync(Ref.update(closed, (current) => [...current, sessionId]));
          });
        }),
    });
    const message = makeRegistryMessage("channel-race");

    const [created, invalidated] = await Effect.runPromise(
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
    expect(await Effect.runPromise(lifecycle.getSession("channel-race"))).toBeUndefined();
    expect(await Effect.runPromise(Ref.get(persisted))).toEqual(new Map());
    expect(await Effect.runPromise(Ref.get(closed))).toEqual(["session-race"]);
  });

  test("does not invalidate a loaded session while it is busy", async () => {
    const { lifecycle, closed, persisted } = await makeHarness({
      isSessionBusy: () => Effect.succeed(true),
    });
    const message = makeRegistryMessage("channel-1");
    const session = await Effect.runPromise(lifecycle.createOrGetSession(message));

    expect(
      await Effect.runPromise(
        lifecycle.invalidateSession("channel-1", "user requested /new-session"),
      ),
    ).toBe(false);

    expect(await Effect.runPromise(Ref.get(closed))).toEqual([]);
    expect(await Effect.runPromise(lifecycle.getSession("channel-1"))).toBe(session);
    expect(await Effect.runPromise(Ref.get(persisted))).toEqual(
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

    const session = await Effect.runPromise(
      lifecycle.createOrGetSession(makeRegistryMessage("channel-1")),
    );
    session.lastActivityAt = 0;

    await Effect.runPromise(lifecycle.closeExpiredSessions(30 * 60 * 1_000 + 1));

    expect(await Effect.runPromise(Ref.get(closed))).toEqual([]);
    expect(await Effect.runPromise(lifecycle.getSession(session.channelId))).toBe(session);
  });
});
