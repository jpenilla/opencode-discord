import type { Message } from "discord.js";
import { Effect, Result } from "effect";

import { OpencodeService } from "@/opencode/service.ts";
import type { LoadedSessionHandle, LoadedSessionHandleSupport } from "@/sessions/loaded/handle.ts";
import { makeLoadedSessionFactory } from "@/sessions/loaded/factory.ts";
import type { LoadedSessionDirectory } from "@/sessions/loaded/directory.ts";
import { SessionStore } from "@/sessions/store.ts";
import type { ActiveRun, ChannelSession } from "@/sessions/types.ts";
import { sessionPathsFromRoot } from "@/state/paths.ts";
import { createKeyedSingleflight } from "@/util/keyed-singleflight.ts";
import { Logger } from "@/util/logging.ts";

export const makeSessionRegistry = (
  loadedSessions: LoadedSessionDirectory,
  support: LoadedSessionHandleSupport,
  sessionInstructions: string,
  triggerPhrase: string,
  idleTimeoutMs?: number,
) =>
  Effect.gen(function* () {
    const sessionStore = yield* SessionStore;
    const opencode = yield* OpencodeService;
    const logger = yield* Logger;
    const sessionGate = createKeyedSingleflight<string>();
    const sessionFactory = makeLoadedSessionFactory({
      loadedSessions,
      sessionStore,
      opencode,
      logger,
      support,
      sessionInstructions,
      triggerPhrase,
    });

    const updateActiveRunHandle = (handle: LoadedSessionHandle, activeRun: ActiveRun | null) =>
      handle.setActiveRun(activeRun);

    const withCurrentHandle = <A>(
      session: ChannelSession,
      whenPresent: (handle: LoadedSessionHandle) => Effect.Effect<A, unknown>,
      whenMissing: () => Effect.Effect<A, unknown>,
    ) =>
      loadedSessions
        .findLoadedHandle(session.channelId)
        .pipe(
          Effect.flatMap((handle) =>
            !handle
              ? whenMissing()
              : handle
                  .readSessionId()
                  .pipe(
                    Effect.flatMap((sessionId) =>
                      sessionId === session.opencode.sessionId
                        ? whenPresent(handle)
                        : whenMissing(),
                    ),
                  ),
          ),
        );

    const updateActiveRun = (session: ChannelSession, activeRun: ActiveRun | null) =>
      withCurrentHandle(
        session,
        (handle) => updateActiveRunHandle(handle, activeRun),
        () =>
          Effect.sync(() => {
            session.activeRun = activeRun;
          }),
      );

    const findActiveRunBySessionId = (sessionId: string) =>
      loadedSessions
        .findLoadedHandleBySessionId(sessionId)
        .pipe(Effect.flatMap((handle) => (handle ? handle.readActiveRun() : Effect.succeed(null))));

    const withSessionGate = <A, R>(channelId: string, task: Effect.Effect<A, unknown, R>) =>
      sessionGate.waitAndRetry(channelId, task);

    const touchSessionActivityHandle = (handle: LoadedSessionHandle, at = Date.now()) =>
      Effect.gen(function* () {
        yield* handle.touchActivity(at);
        const session = yield* handle.readSession();
        yield* sessionStore.touchPersistedSession(session.channelId, at);
      });

    const readSessionBusyHandle = (handle: LoadedSessionHandle) =>
      handle.readActivity().pipe(Effect.map((activity) => activity.isBusy));

    const withExistingOrGatedSession = <A, R>(
      channelId: string,
      onMissing: () => Effect.Effect<A, unknown, R>,
    ) =>
      Effect.gen(function* () {
        const existing = yield* loadedSessions.findLoadedHandle(channelId);
        if (existing) {
          return yield* touchSessionActivityHandle(existing).pipe(Effect.as(existing));
        }

        return yield* withSessionGate(
          channelId,
          Effect.gen(function* () {
            const current = yield* loadedSessions.findLoadedHandle(channelId);
            if (current) {
              return yield* touchSessionActivityHandle(current).pipe(Effect.as(current));
            }
            return yield* onMissing();
          }),
        );
      });

    const unloadSession = (handle: LoadedSessionHandle) =>
      loadedSessions.deleteSession(handle).pipe(Effect.andThen(handle.closeResources()));

    const restoreOrCreateSession = (message: Message) =>
      Effect.gen(function* () {
        const persisted = yield* sessionStore.getPersistedSession(message.channelId);
        if (!persisted) {
          return yield* sessionFactory.createSession(message);
        }

        const now = Date.now();
        const attached = yield* sessionFactory
          .attachPersistedSession(message.channelId, persisted, now)
          .pipe(Effect.result);
        if (Result.isSuccess(attached)) {
          return attached.success;
        }

        yield* logger.warn("failed to attach persisted channel session", {
          channelId: message.channelId,
          sessionId: persisted.opencodeSessionId,
          rootDir: persisted.rootDir,
          error:
            attached.failure instanceof Error ? attached.failure.message : String(attached.failure),
        });

        const { handle } = yield* sessionFactory.createSessionAt({
          channelId: message.channelId,
          rootDir: persisted.rootDir,
          workdir: sessionPathsFromRoot(persisted.rootDir).workdir,
          systemPromptAppend: persisted.systemPromptAppend,
          channelSettings: yield* sessionStore.loadChannelSettings(message.channelId),
          createdAt: persisted.createdAt,
          lastActivityAt: now,
          logReason: "attach failed; created replacement session",
          removePersistedOnActivationFailure: false,
          deleteNewRootOnFailure: false,
        });
        return handle;
      });

    const ensureHandleForMessage = (message: Message) =>
      withExistingOrGatedSession(message.channelId, () => restoreOrCreateSession(message));

    const findOrRestoreHandle = (channelId: string) =>
      withExistingOrGatedSession(channelId, () =>
        sessionStore
          .getPersistedSession(channelId)
          .pipe(
            Effect.flatMap((persisted) =>
              persisted
                ? sessionFactory.attachPersistedSession(channelId, persisted)
                : Effect.succeed(null),
            ),
          ),
      );

    const recreateSession = (session: ChannelSession, message: Message, reason: string) =>
      withSessionGate(
        message.channelId,
        Effect.gen(function* () {
          const currentHandle = yield* loadedSessions.findLoadedHandle(message.channelId);
          if (!currentHandle) {
            return yield* sessionFactory
              .createSession(message)
              .pipe(Effect.flatMap((handle) => handle.readSession()));
          }

          const current = yield* currentHandle.readSession();
          if (current.opencode.sessionId !== session.opencode.sessionId) {
            return current;
          }

          yield* unloadSession(currentHandle);
          const { session: replacement } = yield* sessionFactory.createSessionAt({
            channelId: current.channelId,
            rootDir: current.rootDir,
            workdir: current.workdir,
            systemPromptAppend: current.systemPromptAppend,
            channelSettings: current.channelSettings,
            createdAt: current.createdAt,
            lastActivityAt: Date.now(),
            logReason: "recreated after health recovery",
            removePersistedOnActivationFailure: false,
            deleteNewRootOnFailure: false,
          });
          yield* logger.warn("recovered channel session", {
            channelId: current.channelId,
            previousSessionId: current.opencode.sessionId,
            sessionId: replacement.opencode.sessionId,
            backend: replacement.opencode.backend,
            workdir: current.workdir,
            reason,
          });
          return replacement;
        }),
      );

    const ensureSessionHealth = (
      session: ChannelSession,
      message: Message,
      reason: string,
      allowBusySession = true,
    ) =>
      Effect.gen(function* () {
        if (allowBusySession && session.activeRun) {
          return session;
        }

        const healthy = yield* opencode.isHealthy(session.opencode);
        if (healthy) {
          return session;
        }

        return yield* recreateSession(session, message, reason);
      });

    const ensureSessionHandleHealth = (
      handle: LoadedSessionHandle,
      message: Message,
      reason: string,
      allowBusySession = true,
    ) =>
      handle.readSession().pipe(
        Effect.flatMap((session) =>
          ensureSessionHealth(session, message, reason, allowBusySession),
        ),
        Effect.flatMap((updatedSession) =>
          loadedSessions
            .findLoadedHandle(updatedSession.channelId)
            .pipe(Effect.map((updatedHandle) => updatedHandle ?? handle)),
        ),
      );

    const closeExpiredSessions = (now = Date.now()) =>
      loadedSessions.snapshotHandles().pipe(
        Effect.flatMap((handles) =>
          Effect.forEach(
            handles,
            (handle) =>
              Effect.gen(function* () {
                const session = yield* handle.readSession();
                const activity = yield* handle.readActivity();
                if (
                  activity.isBusy ||
                  !idleTimeoutMs ||
                  now - session.lastActivityAt < idleTimeoutMs
                ) {
                  return;
                }

                yield* unloadSession(handle);
                yield* logger.info("closed idle channel session", {
                  channelId: session.channelId,
                  sessionId: session.opencode.sessionId,
                  idleForMs: now - session.lastActivityAt,
                  workdir: session.workdir,
                });
              }),
            { concurrency: "unbounded", discard: true },
          ),
        ),
      );

    const invalidateSession = (channelId: string, reason: string) =>
      withSessionGate(
        channelId,
        Effect.gen(function* () {
          const loadedHandle = yield* loadedSessions.findLoadedHandle(channelId);
          const persisted = yield* sessionStore.getPersistedSession(channelId);

          if (loadedHandle && (yield* readSessionBusyHandle(loadedHandle))) {
            return false;
          }

          if (loadedHandle) {
            yield* unloadSession(loadedHandle);
          }

          yield* sessionStore.deletePersistedSession(channelId).pipe(Effect.ignore);

          if (loadedHandle) {
            const loadedSession = yield* loadedHandle.readSession();
            yield* logger.info("invalidated loaded channel session", {
              channelId,
              sessionId: loadedSession.opencode.sessionId,
              workdir: loadedSession.workdir,
              reason,
            });
            return true;
          }

          if (persisted) {
            yield* logger.info("invalidated persisted channel session", {
              channelId,
              sessionId: persisted.opencodeSessionId,
              workdir: sessionPathsFromRoot(persisted.rootDir).workdir,
              reason,
            });
          }

          return true;
        }),
      );

    const shutdownSessions = () =>
      loadedSessions.snapshotHandles().pipe(
        Effect.flatMap((handles) =>
          Effect.forEach(handles, unloadSession, {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      );

    return {
      findLoadedHandle: loadedSessions.findLoadedHandle,
      findLoadedHandleBySessionId: loadedSessions.findLoadedHandleBySessionId,
      findLoadedSession: loadedSessions.findLoadedSession,
      findActiveRunBySessionId,
      findLoadedContextBySessionId: loadedSessions.findLoadedContextBySessionId,
      updateActiveRun,
      updateActiveRunHandle,
      ensureHandleForMessage,
      ensureSessionForMessage: (message: Message) =>
        ensureHandleForMessage(message).pipe(Effect.flatMap((handle) => handle.readSession())),
      findOrRestoreHandle,
      findOrRestoreSession: (channelId: string) =>
        findOrRestoreHandle(channelId).pipe(
          Effect.flatMap((handle) => (handle ? handle.readSession() : Effect.succeed(undefined))),
        ),
      ensureHealthySession: ensureSessionHealth,
      ensureHealthyHandle: ensureSessionHandleHealth,
      invalidateSession,
      closeExpiredSessions,
      shutdownSessions,
    } as const;
  });
