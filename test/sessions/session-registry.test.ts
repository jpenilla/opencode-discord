import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { Data, Deferred, Effect, Layer, Ref } from "effect";

import {
  OpencodeService,
  type OpencodeServiceShape,
  type SessionHandle,
} from "@/opencode/service.ts";
import { buildSessionIndex } from "@/sessions/session-index.ts";
import { makeSessionRegistry } from "@/sessions/session-registry.ts";
import { SessionStore, type SessionStoreShape } from "@/sessions/session-store.ts";
import type { ActiveRun } from "@/sessions/session.ts";
import type { PersistedChannelSettings } from "@/state/channel-settings.ts";
import type { PersistedChannelSession } from "@/state/persistence.ts";
import { sessionPathsFromRoot } from "@/state/paths.ts";
import { Logger } from "@/util/logging.ts";
import { makeMessage, makeSilentLogger } from "../support/fixtures.ts";
import { failTest } from "../support/errors.ts";
import {
  appendRef,
  makeDeferred,
  makeRef,
  readRef,
  runConcurrent,
  runTestEffect,
  updateMapRef,
} from "../support/runtime.ts";
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

const runEffect = runTestEffect;

class SettingsUnavailable extends Data.TaggedError("SettingsUnavailable")<{
  readonly message: string;
}> {}

type CreateSessionInput = { workdir: string; title: string; systemPromptAppend?: string };
type HarnessOptions = {
  createOpencodeSession?: (input: CreateSessionInput) => Effect.Effect<SessionHandle, unknown>;
  isSessionHealthy?: (session: SessionHandle) => Effect.Effect<boolean, unknown>;
  isSessionBusy?: (sessionId: string) => Effect.Effect<boolean, unknown>;
  getPersistedChannelSettings?: (
    channelId: string,
  ) => Effect.Effect<PersistedChannelSettings | null, unknown>;
};
const succeed = <A>(deferred: Deferred.Deferred<A, never>, value: A) =>
  Deferred.succeed(deferred, value).pipe(Effect.ignore);
const makeGate = async () => ({ started: await makeDeferred(), release: await makeDeferred() });

const appendClosed = (closed: Ref.Ref<string[]>, sessionId: string) =>
  Effect.runSync(appendRef(closed, sessionId));

const makeHarness = async (options?: HarnessOptions) => {
  const sessionIndex = await runTestEffect(buildSessionIndex());
  const created = await makeRef<CreateSessionInput[]>([]);
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
  }: CreateSessionInput) =>
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
  const sessionStore = unsafeStub<SessionStoreShape>({
    getPersistedSession: (channelId: string) =>
      Ref.get(persisted).pipe(Effect.map((current) => current.get(channelId) ?? null)),
    savePersistedSession: (session: PersistedChannelSession) =>
      updateMapRef(persisted, (current) => current.set(session.channelId, session)),
    loadChannelSettings: (channelId: string) =>
      (
        options?.getPersistedChannelSettings ??
        ((id: string) =>
          Ref.get(persistedSettings).pipe(Effect.map((current) => current.get(id) ?? null)))
      )(channelId).pipe(
        Effect.map((settings) => ({
          showThinking: settings?.showThinking ?? true,
          showCompactionSummaries: settings?.showCompactionSummaries ?? true,
        })),
      ),
    touchPersistedSession: (channelId: string, lastActivityAt: number) =>
      updateMapRef(persisted, (current) => {
        const session = current.get(channelId);
        if (session) {
          current.set(channelId, { ...session, lastActivityAt });
        }
      }),
    deletePersistedSession: (channelId: string) =>
      updateMapRef(persisted, (current) => current.delete(channelId)),
    createSessionPaths,
    deleteSessionRoot: (rootDir: string) => appendRef(removedRoots, rootDir),
  });

  const opencodeService = unsafeStub<OpencodeServiceShape>({
    createSession: (workdir: string, title: string, systemPromptAppend?: string) =>
      (options?.createOpencodeSession ?? defaultCreateOpencodeSession)({
        workdir,
        title,
        systemPromptAppend,
      }),
    attachSession: (workdir: string, sessionId: string) =>
      Effect.succeed(
        makeHandle(sessionId, workdir, (closedSessionId) => appendClosed(closed, closedSessionId)),
      ),
    isHealthy: options?.isSessionHealthy ?? (() => Effect.succeed(true)),
  });

  const lifecycle = await runTestEffect(
    makeSessionRegistry(
      sessionIndex,
      {
        startWorker: (session) => appendRef(started, session.opencode.sessionId),
        readActivity: (session) =>
          (options?.isSessionBusy
            ? options.isSessionBusy(session.opencode.sessionId)
            : Effect.succeed(false)
          ).pipe(
            Effect.map((callbackBusy) => ({
              hasActiveRun: Boolean(session.activeRun),
              hasPendingQuestions: false,
              hasIdleCompaction: false,
              hasQueuedWork: false,
              isBusy: Boolean(session.activeRun) || callbackBusy,
            })),
          ),
        createCompactionWorkflow: () =>
          Effect.succeed({
            hasActive: () => Effect.succeed(false),
            awaitCompletion: () => Effect.void,
            start: () =>
              Effect.succeed({
                type: "rejected",
                message: "unexpected compaction start",
              } as const),
            requestInterrupt: () =>
              Effect.succeed({
                type: "failed",
                message: "unexpected compaction interrupt",
              } as const),
            handleCompacted: () => Effect.void,
            handleInterrupted: () => Effect.void,
            emitSummary: () => Effect.void,
            shutdown: () => Effect.void,
          }),
        routeEvent: () => Effect.void,
        interruptRunForShutdown: () => Effect.succeed(false),
        interruptCompactionForShutdown: () => Effect.void,
        awaitSessionIdleObservedAfterInterrupt: () => Effect.void,
        finalizeInterruptedRunShutdown: () => Effect.void,
      },
      "",
      "hey opencode",
      30 * 60 * 1_000,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(SessionStore, sessionStore),
          Layer.succeed(OpencodeService, opencodeService),
          Layer.succeed(Logger, makeSilentLogger()),
        ),
      ),
    ),
  );

  return {
    lifecycle,
    created,
    started,
    removedRoots,
    closed,
    persisted,
  };
};

type Harness = Awaited<ReturnType<typeof makeHarness>>;

const createLoadedSession = async (lifecycle: Harness["lifecycle"], channelId = "channel-1") => {
  const message = makeRegistryMessage(channelId);
  const session = await runEffect(lifecycle.ensureSessionForMessage(message));
  return { message, session };
};

describe("createSessionRegistry", () => {
  test("single-flights concurrent cold starts for the same channel", async () => {
    const { started: createStarted, release: releaseCreate } = await makeGate();
    const created = await makeRef(0);
    const closed = await makeRef<string[]>([]);

    const { lifecycle } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          const count = yield* Ref.modify(created, (current): readonly [number, number] => {
            const next = current + 1;
            return [next, next];
          });
          yield* succeed(createStarted, undefined);
          yield* Deferred.await(releaseCreate);
          return makeHandle(`session-${count}`, workdir, (sessionId) => {
            Effect.runSync(appendRef(closed, sessionId));
          });
        }),
    });
    const message = makeRegistryMessage("channel-1");

    const [first, second] = await runConcurrent(
      lifecycle.ensureSessionForMessage(message),
      Deferred.await(createStarted).pipe(
        Effect.andThen(succeed(releaseCreate, undefined)),
        Effect.andThen(lifecycle.ensureSessionForMessage(message)),
      ),
    );

    expect(first).toBe(second);
    expect(first.opencode.sessionId).toBe("session-1");
    expect(await readRef(created)).toBe(1);
  });

  test("clears the gate after a failed cold start so a waiting retry can succeed", async () => {
    const { started: createStarted, release: releaseCreate } = await makeGate();
    const createCount = await makeRef(0);
    const { lifecycle, started, removedRoots } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          const count = yield* Ref.modify(createCount, (current): readonly [number, number] => {
            const next = current + 1;
            return [next, next];
          });
          yield* succeed(createStarted, undefined);
          yield* Deferred.await(releaseCreate);
          if (count === 1) {
            return yield* failTest("create failed");
          }
          return makeHandle(`session-${count}`, workdir, () => {});
        }),
    });
    const message = makeRegistryMessage("channel-retry");

    const exits = await runConcurrent(
      Effect.exit(lifecycle.ensureSessionForMessage(message)),
      Deferred.await(createStarted).pipe(
        Effect.andThen(succeed(releaseCreate, undefined)),
        Effect.andThen(Effect.exit(lifecycle.ensureSessionForMessage(message))),
      ),
    );

    expect(exits.map((exit) => exit._tag)).toEqual(["Failure", "Success"]);
    expect(await readRef(removedRoots)).toEqual(["/tmp/session-root-1"]);
    const succeeded = exits.find((exit) => exit._tag === "Success");
    expect(succeeded?._tag).toBe("Success");
    expect(
      succeeded && succeeded._tag === "Success" ? succeeded.value.opencode.sessionId : null,
    ).toBe("session-2");
    expect(await readRef(started)).toEqual(["session-2"]);
  });

  test("cleans the new session root when setup fails before activation", async () => {
    const { lifecycle, removedRoots, started } = await makeHarness({
      getPersistedChannelSettings: () =>
        Effect.fail(new SettingsUnavailable({ message: "settings unavailable" })),
    });

    await expect(
      lifecycle.ensureSessionForMessage(makeRegistryMessage("channel-fail")).pipe(runEffect),
    ).rejects.toThrow("settings unavailable");

    expect(await readRef(removedRoots)).toEqual(["/tmp/session-root-1"]);
    expect(await readRef(started)).toEqual([]);
  });

  test("bypasses health checks for busy sessions by default", async () => {
    const healthChecks = await makeRef<string[]>([]);
    const { lifecycle } = await makeHarness({
      isSessionHealthy: (session) =>
        appendRef(healthChecks, session.sessionId).pipe(Effect.as(true)),
    });
    const { message, session } = await createLoadedSession(lifecycle, "channel-busy");
    session.activeRun = makeActiveRun();

    const result = await runEffect(lifecycle.ensureHealthySession(session, message, "busy"));

    expect(result).toBe(session);
    expect(await readRef(healthChecks)).toEqual([]);
  });

  test("single-flights recovery and rekeys session indexes", async () => {
    const { started: recreateStarted, release: releaseRecreate } = await makeGate();
    const createCount = await makeRef(0);
    const closed = await makeRef<string[]>([]);

    const { lifecycle } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          const count = yield* Ref.modify(createCount, (current): readonly [number, number] => {
            const next = current + 1;
            return [next, next];
          });
          if (count === 2) {
            yield* succeed(recreateStarted, undefined);
            yield* Deferred.await(releaseRecreate);
          }
          return makeHandle(`session-${count}`, workdir, (sessionId) => {
            Effect.runSync(appendRef(closed, sessionId));
          });
        }),
      isSessionHealthy: (session) => Effect.succeed(session.sessionId !== "session-1"),
    });

    const { message, session } = await createLoadedSession(lifecycle, "channel-recover");
    const previousSessionId = session.opencode.sessionId;
    await runEffect(lifecycle.updateActiveRun(session, makeActiveRun()));

    const [first, second] = await runConcurrent(
      lifecycle.ensureHealthySession(session, message, "recover", false),
      Deferred.await(recreateStarted).pipe(
        Effect.andThen(succeed(releaseRecreate, undefined)),
        Effect.andThen(lifecycle.ensureHealthySession(session, message, "recover", false)),
      ),
    );

    expect(first).not.toBe(session);
    expect(second).toBe(first);
    expect(first.opencode.sessionId).toBe("session-2");
    expect(await readRef(createCount)).toBe(2);
    expect(await runEffect(lifecycle.findLoadedSession(message.channelId))).toBe(first);
    expect(await runEffect(lifecycle.findLoadedContextBySessionId(previousSessionId))).toBeNull();
    expect(
      await runEffect(lifecycle.findLoadedContextBySessionId(first.opencode.sessionId)),
    ).toEqual({
      session: first,
      activeRun: null,
    });
    expect(await runEffect(lifecycle.findActiveRunBySessionId(previousSessionId))).toBeNull();
    expect(await readRef(closed)).toEqual(["session-1"]);
  });

  test("shuts down sessions, closes handles, and keeps persistent session roots", async () => {
    const { lifecycle, closed, removedRoots } = await makeHarness();

    await runEffect(lifecycle.ensureSessionForMessage(makeRegistryMessage("channel-1")));
    await runEffect(lifecycle.ensureSessionForMessage(makeRegistryMessage("channel-2")));
    await runEffect(lifecycle.shutdownSessions());

    expect(await readRef(closed)).toEqual(["session-1", "session-2"]);
    expect(await readRef(removedRoots)).toEqual([]);
  });

  test("invalidates the loaded session without deleting the session root", async () => {
    const { lifecycle, closed, removedRoots, persisted } = await makeHarness();
    const { session } = await createLoadedSession(lifecycle);

    expect(
      await runEffect(lifecycle.invalidateSession("channel-1", "user requested /new-session")),
    ).toBe(true);

    expect(await readRef(closed)).toEqual([session.opencode.sessionId]);
    expect(await runEffect(lifecycle.findLoadedSession("channel-1"))).toBeUndefined();
    expect(await readRef(persisted)).toEqual(new Map());
    expect(await readRef(removedRoots)).toEqual([]);
  });

  test("invalidates a session that was still being created", async () => {
    const { started: createStarted, release: releaseCreate } = await makeGate();
    const { lifecycle, closed, persisted } = await makeHarness({
      createOpencodeSession: ({ workdir }) =>
        Effect.gen(function* () {
          yield* succeed(createStarted, undefined);
          yield* Deferred.await(releaseCreate);
          return makeHandle("session-race", workdir, (sessionId) => {
            Effect.runSync(appendRef(closed, sessionId));
          });
        }),
    });
    const message = makeRegistryMessage("channel-race");

    const [created, invalidated] = await runConcurrent(
      lifecycle.ensureSessionForMessage(message),
      Deferred.await(createStarted).pipe(
        Effect.andThen(succeed(releaseCreate, undefined)),
        Effect.andThen(lifecycle.invalidateSession("channel-race", "user requested /new-session")),
      ),
    );

    expect(created.opencode.sessionId).toBe("session-race");
    expect(invalidated).toBe(true);
    expect(await runEffect(lifecycle.findLoadedSession("channel-race"))).toBeUndefined();
    expect(await readRef(persisted)).toEqual(new Map());
    expect(await readRef(closed)).toEqual(["session-race"]);
  });

  test("does not invalidate a loaded session while it is busy", async () => {
    const { lifecycle, closed, persisted } = await makeHarness();
    const { session } = await createLoadedSession(lifecycle);
    session.activeRun = makeActiveRun();

    expect(
      await runEffect(lifecycle.invalidateSession("channel-1", "user requested /new-session")),
    ).toBe(false);

    expect(await readRef(closed)).toEqual([]);
    expect(await runEffect(lifecycle.findLoadedSession("channel-1"))).toBe(session);
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

  test("does not invalidate a loaded session while callback-driven work is present", async () => {
    const { lifecycle, closed, persisted } = await makeHarness({
      isSessionBusy: () => Effect.succeed(true),
    });
    const { session } = await createLoadedSession(lifecycle);

    expect(
      await runEffect(lifecycle.invalidateSession("channel-1", "user requested /new-session")),
    ).toBe(false);

    expect(await readRef(closed)).toEqual([]);
    expect(await runEffect(lifecycle.findLoadedSession("channel-1"))).toBe(session);
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

  test("does not close idle sessions while an active run is present", async () => {
    const { lifecycle, closed } = await makeHarness();
    const { session } = await createLoadedSession(lifecycle);
    session.activeRun = makeActiveRun();
    session.lastActivityAt = 0;

    await runEffect(lifecycle.closeExpiredSessions(30 * 60 * 1_000 + 1));

    expect(await readRef(closed)).toEqual([]);
    expect(await runEffect(lifecycle.findLoadedSession(session.channelId))).toBe(session);
  });

  test("does not close idle sessions while callback-driven work is present", async () => {
    const { lifecycle, closed } = await makeHarness({
      isSessionBusy: () => Effect.succeed(true),
    });
    const { session } = await createLoadedSession(lifecycle);
    session.lastActivityAt = 0;

    await runEffect(lifecycle.closeExpiredSessions(30 * 60 * 1_000 + 1));

    expect(await readRef(closed)).toEqual([]);
    expect(await runEffect(lifecycle.findLoadedSession(session.channelId))).toBe(session);
  });
});
