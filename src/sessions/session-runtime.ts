import type { Interaction, Message, SendableChannels } from "discord.js";
import {
  Effect,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Result,
  ServiceMap,
} from "effect";

import { AppConfig } from "@/config.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards } from "@/discord/info-card.ts";
import { buildSessionSystemAppend } from "@/discord/system-context.ts";
import { OpencodeEventQueue } from "@/opencode/events.ts";
import type { SessionHandle } from "@/opencode/service.ts";
import { OpencodeService } from "@/opencode/service.ts";
import {
  IdleCompactionWorkflow,
  type IdleCompactionWorkflowInterruptResult,
  type IdleCompactionWorkflowShape,
  type IdleCompactionWorkflowStartResult,
  makeIdleCompactionWorkflow,
} from "@/sessions/compaction/idle-compaction-workflow.ts";
import { makeSessionEventHandler } from "@/sessions/event-handler.ts";
import {
  applyQuestionSignals,
  questionTypingAction,
  runQuestionTypingAction,
  type QuestionWorkflowSignal,
} from "@/sessions/question/question-run-state.ts";
import {
  makeQuestionRuntime,
  QuestionRuntime,
  QuestionSignalRouter,
  QuestionSessionLookup,
  type QuestionRuntimeShape,
} from "@/sessions/question/question-runtime.ts";
import { enqueueRunRequest, type RunRequestDestination } from "@/sessions/request-routing.ts";
import { makeRunOrchestrator } from "@/sessions/run/run-executor.ts";
import { takeQueuedRunBatch } from "@/sessions/run/run-batch.ts";
import {
  buildSessionCreateSpec,
  type ActiveRun,
  type ChannelSession,
  type RunRequest,
} from "@/sessions/session.ts";
import {
  defaultChannelSettings,
  resolveChannelSettings,
  type ChannelSettings,
} from "@/state/channel-settings.ts";
import {
  resolveStatePaths,
  sessionPathsForChannel,
  sessionPathsFromRoot,
  type SessionPaths,
} from "@/state/paths.ts";
import { StatePersistence, type PersistedChannelSession } from "@/state/persistence.ts";
import { formatError } from "@/util/errors.ts";
import { createKeyedSingleflight } from "@/util/keyed-singleflight.ts";
import { Logger } from "@/util/logging.ts";

type FsEnv = FileSystem.FileSystem | Path.Path;
type SessionContext = { session: ChannelSession; activeRun: ActiveRun | null };

export type SessionRegistryState = {
  sessionsByChannelId: Map<string, ChannelSession>;
  sessionsBySessionId: Map<string, ChannelSession>;
  activeRunsBySessionId: Map<string, ActiveRun>;
};

export type SessionActivity = {
  hasActiveRun: boolean;
  hasPendingQuestions: boolean;
  hasIdleCompaction: boolean;
  hasQueuedWork: boolean;
  isBusy: boolean;
};

export type ChannelActivity = { type: "missing" } | { type: "present"; activity: SessionActivity };

export type QueuedMessageRunRequest = { sessionId: string; destination: RunRequestDestination };

export type RunInterruptRequestResult =
  | { type: "requested" }
  | { type: "question-pending" }
  | { type: "failed"; error: unknown };

const SHUTDOWN_RPC_TIMEOUT = "1 second";
const SHUTDOWN_GRACE_PERIOD = "10 seconds";
const SHUTDOWN_DRAIN_POLL_INTERVAL = "100 millis";

const withShutdownRpcTimeout =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | string, R> =>
    effect.pipe(
      Effect.timeoutOption(SHUTDOWN_RPC_TIMEOUT),
      Effect.flatMap((result) =>
        Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(message),
      ),
    );

const warnAfterGraceTimeout = (
  effect: Effect.Effect<void, unknown>,
  onTimeout: () => Effect.Effect<void, unknown>,
) =>
  effect.pipe(
    Effect.timeoutOption(SHUTDOWN_GRACE_PERIOD),
    Effect.flatMap(Option.match({ onSome: () => Effect.void, onNone: onTimeout })),
  );

export type SessionRuntimeShape = {
  readLoadedChannelActivity: (channelId: string) => Effect.Effect<ChannelActivity, unknown>;
  readRestoredChannelActivity: (
    channelId: string,
  ) => Effect.Effect<ChannelActivity, unknown, FsEnv>;
  getActiveRunBySessionId: (sessionId: string) => Effect.Effect<ActiveRun | null, unknown>;
  queueMessageRunRequest: (
    message: Message,
    request: RunRequest,
    reason: string,
  ) => Effect.Effect<QueuedMessageRunRequest, unknown, FsEnv>;
  routeQuestionInteraction: (interaction: Interaction) => Effect.Effect<void, unknown>;
  invalidate: (channelId: string, reason: string) => Effect.Effect<boolean, unknown>;
  updateLoadedChannelSettings: (
    channelId: string,
    settings: ChannelSettings,
  ) => Effect.Effect<void, unknown>;
  requestRunInterrupt: (
    channelId: string,
  ) => Effect.Effect<RunInterruptRequestResult, unknown, FsEnv>;
  startCompaction: (
    channelId: string,
    channel: SendableChannels,
  ) => Effect.Effect<IdleCompactionWorkflowStartResult, unknown, FsEnv>;
  requestCompactionInterrupt: (
    channelId: string,
  ) => Effect.Effect<IdleCompactionWorkflowInterruptResult, unknown, FsEnv>;
  shutdown: () => Effect.Effect<void, unknown>;
};

export class SessionRuntime extends ServiceMap.Service<SessionRuntime, SessionRuntimeShape>()(
  "SessionRuntime",
) {}
export type SessionStoreShape = {
  getPersistedSession: (
    channelId: string,
  ) => Effect.Effect<PersistedChannelSession | null, unknown>;
  savePersistedSession: (session: PersistedChannelSession) => Effect.Effect<void, unknown>;
  loadChannelSettings: (channelId: string) => Effect.Effect<ChannelSettings, unknown>;
  touchPersistedSession: (
    channelId: string,
    lastActivityAt: number,
  ) => Effect.Effect<void, unknown>;
  deletePersistedSession: (channelId: string) => Effect.Effect<void, unknown>;
  createSessionPaths: (channelId: string) => Effect.Effect<SessionPaths, unknown>;
  deleteSessionRoot: (rootDir: string) => Effect.Effect<void, unknown>;
};

export class SessionStore extends ServiceMap.Service<SessionStore, SessionStoreShape>()(
  "SessionStore",
) {}

const SessionStoreLayer = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const fs = yield* FileSystem.FileSystem;
    const statePersistence = yield* StatePersistence;
    const statePaths = resolveStatePaths(config.stateDir);
    const channelSettingsDefaults = defaultChannelSettings(config);

    return {
      getPersistedSession: statePersistence.getSession,
      savePersistedSession: statePersistence.upsertSession,
      loadChannelSettings: (channelId) =>
        statePersistence
          .getChannelSettings(channelId)
          .pipe(
            Effect.map((persisted) =>
              persisted
                ? resolveChannelSettings(channelSettingsDefaults, persisted)
                : { ...channelSettingsDefaults },
            ),
          ),
      touchPersistedSession: statePersistence.touchSession,
      deletePersistedSession: statePersistence.deleteSession,
      createSessionPaths: (channelId) =>
        Effect.gen(function* () {
          const sessionPaths = sessionPathsForChannel(statePaths.sessionsRootDir, channelId);
          yield* fs.makeDirectory(sessionPaths.workdir, { recursive: true });
          return sessionPaths;
        }),
      deleteSessionRoot: (rootDir) =>
        fs.remove(rootDir, { recursive: true, force: true }).pipe(Effect.ignore),
    } satisfies SessionStoreShape;
  }),
);

export const createSessionIndex = (stateRef: Ref.Ref<SessionRegistryState>) => {
  const read = <A>(map: (state: SessionRegistryState) => A) =>
    Ref.get(stateRef).pipe(Effect.map(map));
  const update = (f: (state: SessionRegistryState) => void) =>
    Ref.update(stateRef, (current) => {
      const next = {
        ...current,
        sessionsByChannelId: new Map(current.sessionsByChannelId),
        sessionsBySessionId: new Map(current.sessionsBySessionId),
        activeRunsBySessionId: new Map(current.activeRunsBySessionId),
      };
      f(next);
      return next;
    });

  return {
    updateSession: (
      session: ChannelSession,
      options?: {
        previousSessionId?: string;
        activeRun?: ActiveRun | null;
      },
    ) =>
      update((state) => {
        const previousSessionId = options?.previousSessionId ?? session.opencode.sessionId;
        const activeRun = options && "activeRun" in options ? options.activeRun : session.activeRun;
        state.sessionsByChannelId.set(session.channelId, session);
        state.sessionsBySessionId.delete(previousSessionId);
        state.sessionsBySessionId.set(session.opencode.sessionId, session);
        state.activeRunsBySessionId.delete(previousSessionId);
        if (activeRun) {
          state.activeRunsBySessionId.set(session.opencode.sessionId, activeRun);
        }
      }),
    deleteSession: (session: ChannelSession) =>
      update((state) => {
        state.sessionsByChannelId.delete(session.channelId);
        state.sessionsBySessionId.delete(session.opencode.sessionId);
        state.activeRunsBySessionId.delete(session.opencode.sessionId);
      }),
    getSession: (channelId: string) => read((state) => state.sessionsByChannelId.get(channelId)),
    getActiveRunBySessionId: (sessionId: string) =>
      read((state) => state.activeRunsBySessionId.get(sessionId) ?? null),
    getSessionContext: (sessionId: string) =>
      read((state): SessionContext | null => {
        const session = state.sessionsBySessionId.get(sessionId);
        return session
          ? { session, activeRun: state.activeRunsBySessionId.get(sessionId) ?? null }
          : null;
      }),
    snapshotSessions: () => read((state) => [...state.sessionsByChannelId.values()]),
  } as const;
};

type SessionIndex = ReturnType<typeof createSessionIndex>;

const createSessionLifecycle = (
  sessionIndex: SessionIndex,
  startWorker: (session: ChannelSession) => Effect.Effect<void, unknown, FsEnv>,
  sessionInstructions: string,
  triggerPhrase: string,
  idleTimeoutMs?: number,
  checkSessionBusy?: (session: ChannelSession) => Effect.Effect<boolean, unknown>,
) =>
  Effect.gen(function* () {
    const sessionStore = yield* SessionStore;
    const opencode = yield* OpencodeService;
    const logger = yield* Logger;
    const sessionGate = createKeyedSingleflight<string>();

    const { getSession, getActiveRunBySessionId, getSessionContext } = sessionIndex;

    const toPersistedSession = (session: ChannelSession): PersistedChannelSession => ({
      channelId: session.channelId,
      opencodeSessionId: session.opencode.sessionId,
      rootDir: session.rootDir,
      systemPromptAppend: session.systemPromptAppend,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
    });

    const setActiveRun = (session: ChannelSession, activeRun: ActiveRun | null) =>
      Effect.sync(() => {
        session.activeRun = activeRun;
      }).pipe(Effect.andThen(sessionIndex.updateSession(session)));

    const replaceSessionHandle = (
      session: ChannelSession,
      replacement: ChannelSession["opencode"],
    ) => {
      const previousSessionId = session.opencode.sessionId;
      return Effect.sync(() => {
        session.opencode = replacement;
      }).pipe(
        Effect.andThen(
          sessionIndex.updateSession(session, {
            previousSessionId,
            activeRun: null,
          }),
        ),
      );
    };

    const withSessionGate = <A, R>(channelId: string, task: Effect.Effect<A, unknown, R>) =>
      sessionGate.waitAndRetry(channelId, task);

    const touchSessionActivity = (session: ChannelSession, at = Date.now()) =>
      Effect.gen(function* () {
        session.lastActivityAt = at;
        yield* sessionStore.touchPersistedSession(session.channelId, at);
      });

    const readSessionBusy = (session: ChannelSession) =>
      session.activeRun
        ? Effect.succeed(true)
        : (checkSessionBusy?.(session) ?? Effect.succeed(false));

    const activateSession = (
      session: ChannelSession,
      options?: {
        removePersistedOnFailure?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        yield* sessionStore.savePersistedSession(toPersistedSession(session));
        yield* sessionIndex.updateSession(session);
        yield* startWorker(session);
        return session;
      }).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            yield* sessionIndex.deleteSession(session);
            yield* session.opencode.close().pipe(Effect.ignore);
            if (options?.removePersistedOnFailure) {
              yield* sessionStore.deletePersistedSession(session.channelId).pipe(Effect.ignore);
            }
          }).pipe(Effect.ignore),
        ),
      );

    const buildSession = (input: {
      channelId: string;
      opencode: SessionHandle;
      rootDir: string;
      workdir: string;
      systemPromptAppend?: string;
      channelSettings: ChannelSettings;
      createdAt: number;
      lastActivityAt: number;
    }) =>
      Queue.unbounded<RunRequest>().pipe(
        Effect.map(
          (queue) =>
            ({
              channelId: input.channelId,
              opencode: input.opencode,
              systemPromptAppend: input.systemPromptAppend,
              rootDir: input.rootDir,
              workdir: input.workdir,
              createdAt: input.createdAt,
              lastActivityAt: input.lastActivityAt,
              channelSettings: input.channelSettings,
              progressChannel: null,
              progressMentionContext: null,
              emittedCompactionSummaryMessageIds: new Set<string>(),
              queue,
              activeRun: null,
            }) satisfies ChannelSession,
        ),
      );

    const createSessionAt = (input: {
      channelId: string;
      rootDir: string;
      workdir: string;
      systemPromptAppend?: string;
      channelSettings: ChannelSettings;
      createdAt: number;
      lastActivityAt: number;
      logReason?: string;
      removePersistedOnActivationFailure?: boolean;
      deleteNewRootOnFailure?: boolean;
    }) =>
      Effect.gen(function* () {
        const createSpec = buildSessionCreateSpec(input);
        const opencodeSession = yield* opencode.createSession(
          createSpec.workdir,
          createSpec.title,
          createSpec.systemPromptAppend,
        );
        const session = yield* buildSession({
          channelId: input.channelId,
          opencode: opencodeSession,
          rootDir: input.rootDir,
          workdir: input.workdir,
          systemPromptAppend: input.systemPromptAppend,
          channelSettings: input.channelSettings,
          createdAt: input.createdAt,
          lastActivityAt: input.lastActivityAt,
        });

        yield* activateSession(session, {
          removePersistedOnFailure: input.removePersistedOnActivationFailure,
        });

        yield* logger.info("created channel session", {
          channelId: input.channelId,
          sessionId: opencodeSession.sessionId,
          backend: opencodeSession.backend,
          workdir: input.workdir,
          triggerPhrase,
          reason: input.logReason,
        });

        return session;
      }).pipe(
        Effect.onError(() =>
          input.deleteNewRootOnFailure
            ? sessionStore.deleteSessionRoot(input.rootDir).pipe(Effect.ignore)
            : Effect.void,
        ),
      );

    const createSession = (message: Message) =>
      Effect.gen(function* () {
        const { rootDir, workdir } = yield* sessionStore.createSessionPaths(message.channelId);
        return yield* Effect.gen(function* () {
          const now = Date.now();
          return yield* createSessionAt({
            channelId: message.channelId,
            rootDir,
            workdir,
            systemPromptAppend: buildSessionSystemAppend({
              message,
              additionalInstructions: sessionInstructions,
            }),
            channelSettings: yield* sessionStore.loadChannelSettings(message.channelId),
            createdAt: now,
            lastActivityAt: now,
            removePersistedOnActivationFailure: true,
            deleteNewRootOnFailure: false,
          });
        }).pipe(Effect.onError(() => sessionStore.deleteSessionRoot(rootDir).pipe(Effect.ignore)));
      });

    const attachPersistedSession = (
      channelId: string,
      persisted: PersistedChannelSession,
      lastActivityAt = Date.now(),
    ) =>
      Effect.gen(function* () {
        const { workdir } = sessionPathsFromRoot(persisted.rootDir);
        const channelSettings = yield* sessionStore.loadChannelSettings(channelId);

        const opencodeSession = yield* opencode.attachSession(
          workdir,
          persisted.opencodeSessionId,
          persisted.systemPromptAppend,
        );
        const session = yield* buildSession({
          channelId,
          opencode: opencodeSession,
          rootDir: persisted.rootDir,
          workdir,
          systemPromptAppend: persisted.systemPromptAppend,
          channelSettings,
          createdAt: persisted.createdAt,
          lastActivityAt,
        });
        yield* activateSession(session);
        yield* logger.info("attached channel session", {
          channelId,
          sessionId: opencodeSession.sessionId,
          backend: opencodeSession.backend,
          workdir,
        });
        return session;
      });

    const withExistingOrGatedSession = <A, R>(
      channelId: string,
      onMissing: () => Effect.Effect<A, unknown, R>,
    ) =>
      Effect.gen(function* () {
        const existing = yield* getSession(channelId);
        if (existing) {
          return yield* touchSessionActivity(existing).pipe(Effect.as(existing));
        }

        return yield* withSessionGate(
          channelId,
          Effect.gen(function* () {
            const current = yield* getSession(channelId);
            if (current) {
              return yield* touchSessionActivity(current).pipe(Effect.as(current));
            }
            return yield* onMissing();
          }),
        );
      });

    const closeSessionResources = (session: ChannelSession) =>
      Queue.shutdown(session.queue).pipe(
        Effect.ignore,
        Effect.andThen(session.opencode.close().pipe(Effect.ignore)),
      );

    const unloadSession = (session: ChannelSession) =>
      sessionIndex.deleteSession(session).pipe(Effect.andThen(closeSessionResources(session)));

    const restoreOrCreateSession = (message: Message) =>
      Effect.gen(function* () {
        const persisted = yield* sessionStore.getPersistedSession(message.channelId);
        if (!persisted) {
          return yield* createSession(message);
        }

        const now = Date.now();
        const attached = yield* attachPersistedSession(message.channelId, persisted, now).pipe(
          Effect.result,
        );
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

        return yield* createSessionAt({
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
      });

    const createOrGetSession = (message: Message) =>
      withExistingOrGatedSession(message.channelId, () => restoreOrCreateSession(message));

    const getOrRestoreSession = (channelId: string) =>
      withExistingOrGatedSession(channelId, () =>
        sessionStore
          .getPersistedSession(channelId)
          .pipe(
            Effect.flatMap((persisted) =>
              persisted ? attachPersistedSession(channelId, persisted) : Effect.succeed(null),
            ),
          ),
      );

    const recreateSession = (session: ChannelSession, message: Message, reason: string) =>
      withSessionGate(
        message.channelId,
        Effect.gen(function* () {
          const current = yield* getSession(message.channelId);
          if (!current) {
            return yield* createSession(message);
          }

          if (current.opencode.sessionId !== session.opencode.sessionId) {
            return current;
          }

          const previous = current.opencode;
          const replacement = yield* opencode.createSession(
            current.workdir,
            `Discord #${message.channelId}`,
            current.systemPromptAppend,
          );
          yield* replaceSessionHandle(current, replacement);
          yield* sessionStore.savePersistedSession(toPersistedSession(current));
          yield* previous.close().pipe(Effect.ignore);
          yield* logger.warn("recovered channel session", {
            channelId: current.channelId,
            previousSessionId: previous.sessionId,
            sessionId: replacement.sessionId,
            backend: replacement.backend,
            workdir: current.workdir,
            reason,
          });
          return current;
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

    const closeExpiredSessions = (now = Date.now()) =>
      sessionIndex.snapshotSessions().pipe(
        Effect.flatMap((sessions) =>
          Effect.forEach(
            sessions,
            (session) =>
              Effect.gen(function* () {
                const busy = yield* readSessionBusy(session);
                if (busy || !idleTimeoutMs || now - session.lastActivityAt < idleTimeoutMs) {
                  return;
                }

                yield* unloadSession(session);
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
          const loadedSession = yield* getSession(channelId);
          const persisted = yield* sessionStore.getPersistedSession(channelId);

          if (loadedSession && (yield* readSessionBusy(loadedSession))) {
            return false;
          }

          if (loadedSession) {
            yield* unloadSession(loadedSession);
          }

          yield* sessionStore.deletePersistedSession(channelId).pipe(Effect.ignore);

          if (loadedSession) {
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
      sessionIndex
        .snapshotSessions()
        .pipe(
          Effect.flatMap((sessions) =>
            Effect.forEach(sessions, unloadSession, { concurrency: "unbounded", discard: true }),
          ),
        );

    return {
      getSession,
      getActiveRunBySessionId,
      getSessionContext,
      setActiveRun,
      createOrGetSession,
      getOrRestoreSession,
      ensureSessionHealth,
      invalidateSession,
      closeExpiredSessions,
      shutdownSessions,
    } as const;
  });

export const createSessionRegistry = createSessionLifecycle;

export const SessionRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const logger = yield* Logger;
    const config = yield* AppConfig;
    const infoCards = yield* InfoCards;
    const opencode = yield* OpencodeService;
    const eventQueue = yield* OpencodeEventQueue;
    const stateRef = yield* Ref.make<SessionRegistryState>({
      sessionsByChannelId: new Map(),
      sessionsBySessionId: new Map(),
      activeRunsBySessionId: new Map(),
    });
    const shutdownStartedRef = yield* Ref.make(false);
    const typingPausedRef = yield* Ref.make(new Set<string>());
    const fiberSet = yield* FiberSet.make();
    let idleCompactionWorkflow: IdleCompactionWorkflowShape | null = null;
    let questionRuntime: QuestionRuntimeShape | null = null;
    const sessionIndex = createSessionIndex(stateRef);

    const isSessionBusy = (session: ChannelSession) =>
      session.activeRun
        ? Effect.succeed(true)
        : Effect.gen(function* () {
            const hasPendingQuestions = questionRuntime
              ? yield* questionRuntime.hasPendingQuestions(session.opencode.sessionId)
              : false;
            if (hasPendingQuestions) {
              return true;
            }
            return idleCompactionWorkflow
              ? yield* idleCompactionWorkflow.hasActive(session.opencode.sessionId)
              : false;
          });

    const sendQuestionUiFailure = (message: Message, error: unknown) =>
      Effect.promise(() =>
        message.reply({
          content: formatErrorResponse("## ❌ Failed to show questions", formatError(error)),
          allowedMentions: { repliedUser: false, parse: [] },
        }),
      );

    const sessionLifecycle = yield* createSessionLifecycle(
      sessionIndex,
      (session) =>
        FiberSet.run(fiberSet, { startImmediately: true })(worker(session)).pipe(Effect.asVoid),
      config.sessionInstructions,
      config.triggerPhrase,
      config.sessionIdleTimeoutMs,
      isSessionBusy,
    ).pipe(Effect.provide(SessionStoreLayer));
    const {
      getSession,
      getActiveRunBySessionId,
      getSessionContext,
      setActiveRun,
      createOrGetSession,
      getOrRestoreSession,
      ensureSessionHealth,
      invalidateSession,
      closeExpiredSessions,
      shutdownSessions,
    } = sessionLifecycle;

    const serviceLayer = Layer.mergeAll(
      Layer.succeed(Logger, logger),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(OpencodeService, opencode),
    );
    let questions!: QuestionRuntimeShape;

    const syncTyping = (sessionId: string) =>
      getSessionContext(sessionId).pipe(
        Effect.flatMap((context) => {
          const activeRun = context?.activeRun ?? null;
          if (!activeRun) {
            return Ref.update(typingPausedRef, (current) => {
              if (!current.has(sessionId)) {
                return current;
              }
              const next = new Set(current);
              next.delete(sessionId);
              return next;
            });
          }

          return questions.hasPendingQuestions(sessionId).pipe(
            Effect.flatMap((pending) =>
              Ref.modify(typingPausedRef, (current) => {
                const wasPaused = current.has(sessionId);
                const next = new Set(current);
                if (pending) {
                  next.add(sessionId);
                } else {
                  next.delete(sessionId);
                }
                return [{ pending, wasPaused }, next] as const;
              }).pipe(
                Effect.flatMap(({ pending, wasPaused }) =>
                  runQuestionTypingAction({
                    sessionId,
                    activeRun,
                    action: questionTypingAction(activeRun, pending, wasPaused),
                    logger,
                  }),
                ),
              ),
            ),
          );
        }),
      );

    const applySessionSignals = (
      sessionId: string,
      signals: ReadonlyArray<QuestionWorkflowSignal>,
    ) =>
      getSessionContext(sessionId).pipe(
        Effect.flatMap((context) => applyQuestionSignals(context?.activeRun ?? null, signals)),
        Effect.andThen(syncTyping(sessionId)),
      );
    const questionSignalRouter = { apply: applySessionSignals };
    questions = yield* makeQuestionRuntime(sendQuestionUiFailure).pipe(
      Effect.provide(
        Layer.mergeAll(
          serviceLayer,
          Layer.succeed(QuestionSessionLookup, {
            getSessionContext,
          }),
          Layer.succeed(QuestionSignalRouter, questionSignalRouter),
        ),
      ),
    );
    questionRuntime = questions;

    const idleCompaction = yield* makeIdleCompactionWorkflow().pipe(Effect.provide(serviceLayer));
    idleCompactionWorkflow = idleCompaction;
    const runtimeServiceLayer = Layer.mergeAll(
      serviceLayer,
      Layer.succeed(QuestionRuntime, questions),
      Layer.succeed(IdleCompactionWorkflow, idleCompaction),
    );

    const eventHandler = yield* makeSessionEventHandler.pipe(
      Effect.provide(
        Layer.mergeAll(
          runtimeServiceLayer,
          Layer.succeed(QuestionSessionLookup, {
            getSessionContext,
          }),
        ),
      ),
    );

    yield* Queue.take(eventQueue).pipe(
      Effect.flatMap((event) => eventHandler.handleEvent(event.payload)),
      Effect.forever,
      Effect.catch((error) =>
        logger.error("opencode event dispatcher failed", {
          error: formatError(error),
        }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.sleep(60_000).pipe(
      Effect.andThen(closeExpiredSessions()),
      Effect.forever,
      Effect.catch((error) =>
        logger.error("idle session sweeper failed", {
          error: formatError(error),
        }),
      ),
      Effect.forkScoped,
    );

    const runBatch = yield* makeRunOrchestrator({
      setActiveRun,
      recoverSession: (session, responseMessage) =>
        ensureSessionHealth(
          session,
          responseMessage,
          "run failed with unhealthy opencode session",
          false,
        ),
    }).pipe(Effect.provide(runtimeServiceLayer));

    const worker = (session: ChannelSession): Effect.Effect<never, never, FsEnv> =>
      Effect.forever(
        takeQueuedRunBatch(session.queue).pipe(
          Effect.flatMap((requests) =>
            Ref.get(shutdownStartedRef).pipe(
              Effect.flatMap((shutdownStarted) =>
                shutdownStarted ? Effect.void : runBatch(session, requests),
              ),
            ),
          ),
          Effect.catch((error) =>
            logger.error("channel worker iteration failed", {
              channelId: session.channelId,
              error: formatError(error),
            }),
          ),
        ),
      );

    const shutdown = () => {
      const startShutdown = () =>
        Ref.modify(shutdownStartedRef, (started): readonly [boolean, boolean] => [!started, true]);
      const readState = () => Ref.get(stateRef);
      const sessionFields = (session: ChannelSession) => ({
        channelId: session.channelId,
        sessionId: session.opencode.sessionId,
      });
      const catchShutdownWarn =
        (message: string, context: (error: unknown) => Record<string, unknown> = () => ({})) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.catch((error) =>
              logger.warn(message, {
                ...context(error),
                error: formatError(error),
              }),
            ),
          );
      const forceCloseSessionHandle = (session: ChannelSession, reason: string) =>
        session.opencode.close().pipe(
          catchShutdownWarn("failed to force-close opencode session during shutdown", () => ({
            ...sessionFields(session),
            reason,
          })),
        );
      const interruptRunForShutdown = (session: ChannelSession, activeRun: ActiveRun) =>
        Effect.gen(function* () {
          activeRun.interruptRequested = true;
          activeRun.interruptSource = "shutdown";

          const result = yield* opencode
            .interruptSession(session.opencode)
            .pipe(
              withShutdownRpcTimeout("Timed out interrupting active run during shutdown"),
              Effect.result,
            );
          if (Result.isSuccess(result)) {
            return true;
          }

          yield* logger.warn("run interrupt was unresponsive during shutdown", {
            ...sessionFields(session),
            error: formatError(result.failure),
          });
          yield* forceCloseSessionHandle(session, "run interrupt timed out or failed");
          return false;
        });
      const awaitSessionIdleObservedAfterInterruptLoop = (
        sessionId: string,
      ): Effect.Effect<void, unknown> =>
        readState().pipe(
          Effect.flatMap((state) =>
            state.activeRunsBySessionId.has(sessionId)
              ? Effect.sleep(SHUTDOWN_DRAIN_POLL_INTERVAL).pipe(
                  Effect.andThen(awaitSessionIdleObservedAfterInterruptLoop(sessionId)),
                )
              : Effect.void,
          ),
        );
      const awaitSessionIdleObservedAfterInterrupt = (session: ChannelSession) =>
        warnAfterGraceTimeout(
          awaitSessionIdleObservedAfterInterruptLoop(session.opencode.sessionId),
          () =>
            logger.warn(
              "active run did not reach observed idle before question shutdown",
              sessionFields(session),
            ),
        );
      const interruptIdleCompactionForShutdown = (session: ChannelSession) =>
        idleCompaction.requestInterrupt({ session }).pipe(
          withShutdownRpcTimeout("Timed out interrupting idle compaction during shutdown"),
          Effect.flatMap((result) =>
            result.type === "failed" ? Effect.fail(result.message) : Effect.void,
          ),
          Effect.catch((error) =>
            logger
              .warn("idle compaction interrupt was unresponsive during shutdown", {
                ...sessionFields(session),
                error: formatError(error),
              })
              .pipe(
                Effect.andThen(
                  forceCloseSessionHandle(session, "idle compaction interrupt timed out or failed"),
                ),
                Effect.andThen(
                  idleCompaction
                    .handleInterrupted(session.opencode.sessionId)
                    .pipe(
                      catchShutdownWarn(
                        "failed to finalize idle compaction after forced shutdown",
                        () => sessionFields(session),
                      ),
                    ),
                ),
              ),
          ),
        );
      const requestSessionShutdown = (session: ChannelSession) =>
        Effect.gen(function* () {
          yield* Queue.clear(session.queue).pipe(Effect.asVoid);

          if (session.activeRun) {
            const interrupted = yield* interruptRunForShutdown(session, session.activeRun);
            if (interrupted) {
              yield* awaitSessionIdleObservedAfterInterrupt(session);
            }
            yield* questions.shutdownSession(session.opencode.sessionId);
            return;
          }

          if (yield* idleCompaction.hasActive(session.opencode.sessionId)) {
            yield* interruptIdleCompactionForShutdown(session);
          }
          yield* questions.shutdownSession(session.opencode.sessionId);
        });
      const readShutdownDrainState = () =>
        Effect.gen(function* () {
          const state = yield* readState();
          const sessionIds = [...state.sessionsBySessionId.keys()];
          const hasActiveRuns = state.activeRunsBySessionId.size > 0;
          const hasIdleCompactions =
            sessionIds.length > 0 &&
            (yield* Effect.forEach(sessionIds, idleCompaction.hasActive, {
              concurrency: "unbounded",
              discard: false,
            })).some(Boolean);
          const hasPendingQuestions = yield* questions.hasPendingQuestionsAnywhere();

          return hasActiveRuns || hasIdleCompactions || hasPendingQuestions
            ? { hasActiveRuns, hasIdleCompactions, hasPendingQuestions }
            : null;
        });
      const awaitShutdownDrainLoop = (): Effect.Effect<void, unknown> =>
        readShutdownDrainState().pipe(
          Effect.flatMap((drainState) =>
            !drainState
              ? Effect.void
              : Effect.sleep(SHUTDOWN_DRAIN_POLL_INTERVAL).pipe(
                  Effect.andThen(awaitShutdownDrainLoop()),
                ),
          ),
        );
      const awaitShutdownDrain = () =>
        warnAfterGraceTimeout(awaitShutdownDrainLoop(), () =>
          readShutdownDrainState().pipe(
            Effect.flatMap((drainState) =>
              logger.warn("shutdown grace period elapsed before local work drained", {
                hasActiveRuns: drainState?.hasActiveRuns ?? false,
                hasIdleCompactions: drainState?.hasIdleCompactions ?? false,
                hasPendingQuestions: drainState?.hasPendingQuestions ?? false,
              }),
            ),
          ),
        );
      const finalizeShutdownCleanup = () =>
        Effect.gen(function* () {
          yield* questions
            .cleanupShutdownQuestions()
            .pipe(catchShutdownWarn("failed to finalize pending questions during shutdown"));

          const state = yield* readState();
          const activeRuns = [...state.activeRunsBySessionId.entries()];
          const idleCompactionSessionIds = (yield* Effect.forEach(
            state.sessionsBySessionId.keys(),
            (sessionId) =>
              idleCompaction
                .hasActive(sessionId)
                .pipe(Effect.map((active) => (active ? sessionId : null))),
            { concurrency: "unbounded", discard: false },
          )).filter((sessionId): sessionId is string => sessionId !== null);

          yield* Effect.forEach(
            activeRuns,
            ([sessionId, activeRun]) =>
              Effect.gen(function* () {
                yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore);
                yield* activeRun
                  .finalizeProgress("interrupted")
                  .pipe(
                    catchShutdownWarn(
                      "failed to finalize interrupted run progress during shutdown",
                      () => ({ sessionId }),
                    ),
                  );
                yield* infoCards
                  .send(
                    activeRun.originMessage.channel as SendableChannels,
                    "🛑 Run interrupted",
                    "OpenCode stopped the active run in this channel because the bot is shutting down.",
                  )
                  .pipe(
                    catchShutdownWarn("failed to post shutdown interrupt info card", () => ({
                      channelId: activeRun.originMessage.channelId,
                      sessionId,
                    })),
                    Effect.ignore,
                  );
              }),
            { concurrency: "unbounded", discard: true },
          );

          yield* Effect.forEach(
            idleCompactionSessionIds,
            (sessionId) =>
              idleCompaction.handleInterrupted(sessionId).pipe(
                catchShutdownWarn("failed to finalize idle compaction on shutdown", () => ({
                  sessionId,
                })),
              ),
            { concurrency: "unbounded", discard: true },
          );
        });

      return startShutdown().pipe(
        Effect.flatMap((shouldRun) =>
          !shouldRun
            ? Effect.void
            : Effect.gen(function* () {
                yield* idleCompaction
                  .shutdown()
                  .pipe(catchShutdownWarn("failed to begin idle compaction shutdown"));
                const state = yield* readState();
                yield* Effect.forEach(
                  [...state.sessionsBySessionId.values()],
                  requestSessionShutdown,
                  {
                    concurrency: "unbounded",
                    discard: true,
                  },
                );
                yield* awaitShutdownDrain();
                yield* finalizeShutdownCleanup();
                yield* FiberSet.clear(fiberSet).pipe(
                  catchShutdownWarn("failed to interrupt session workers on shutdown"),
                );
                yield* shutdownSessions().pipe(catchShutdownWarn("failed to shut down sessions"));
              }),
        ),
        Effect.catch((error) =>
          logger.warn("session orchestrator shutdown failed", {
            error: formatError(error),
          }),
        ),
      );
    };

    const readSessionActivity = (session: ChannelSession) =>
      Effect.all({
        hasPendingQuestions: questions.hasPendingQuestions(session.opencode.sessionId),
        hasIdleCompaction: idleCompaction.hasActive(session.opencode.sessionId),
        hasQueuedWork: Queue.size(session.queue).pipe(Effect.map((size) => size > 0)),
        isBusy: isSessionBusy(session),
      }).pipe(
        Effect.map(
          ({ hasPendingQuestions, hasIdleCompaction, hasQueuedWork, isBusy }) =>
            ({
              hasActiveRun: Boolean(session.activeRun),
              hasPendingQuestions,
              hasIdleCompaction,
              hasQueuedWork,
              isBusy,
            }) satisfies SessionActivity,
        ),
      );

    const readChannelActivity = <R>(
      sessionEffect: Effect.Effect<ChannelSession | null | undefined, unknown, R>,
    ) =>
      sessionEffect.pipe(
        Effect.flatMap((session) =>
          !session
            ? Effect.succeed<ChannelActivity>({ type: "missing" })
            : readSessionActivity(session).pipe(
                Effect.map(
                  (activity): ChannelActivity => ({
                    type: "present",
                    activity,
                  }),
                ),
              ),
        ),
      );

    const setInterruptState = (
      activeRun: ActiveRun,
      interruptRequested: boolean,
      interruptSource: ActiveRun["interruptSource"],
    ) =>
      Effect.sync(() => {
        activeRun.interruptRequested = interruptRequested;
        activeRun.interruptSource = interruptSource;
      });

    const interruptFailure = (error: string | unknown): RunInterruptRequestResult => ({
      type: "failed",
      error: typeof error === "string" ? new Error(error) : error,
    });

    const requestSessionRunInterrupt = (session: ChannelSession) =>
      Effect.gen(function* () {
        const activeRun = session.activeRun;
        if (!activeRun) {
          return interruptFailure("no active run for session");
        }

        yield* setInterruptState(activeRun, true, "user");
        return yield* opencode.interruptSession(session.opencode).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              setInterruptState(activeRun, false, null).pipe(Effect.as(interruptFailure(error))),
            onSuccess: () =>
              readSessionActivity(session).pipe(
                Effect.flatMap((updatedActivity) =>
                  !updatedActivity.hasPendingQuestions
                    ? Effect.succeed<RunInterruptRequestResult>({ type: "requested" })
                    : setInterruptState(activeRun, false, null).pipe(
                        Effect.as<RunInterruptRequestResult>({ type: "question-pending" }),
                      ),
                ),
              ),
          }),
        );
      });

    const withRestoredSession = <A>(
      channelId: string,
      onPresent: (session: ChannelSession) => Effect.Effect<A, unknown, FsEnv>,
      onMissing: () => Effect.Effect<A, unknown>,
    ) =>
      getOrRestoreSession(channelId).pipe(
        Effect.flatMap((session) => (session ? onPresent(session) : onMissing())),
      );

    return Layer.succeed(SessionRuntime, {
      readLoadedChannelActivity: (channelId) => readChannelActivity(getSession(channelId)),
      readRestoredChannelActivity: (channelId) =>
        readChannelActivity(getOrRestoreSession(channelId)),
      getActiveRunBySessionId,
      queueMessageRunRequest: (message, request, reason) =>
        Effect.gen(function* () {
          const session = yield* createOrGetSession(message).pipe(
            Effect.flatMap((session) => ensureSessionHealth(session, message, reason)),
          );
          session.progressChannel = message.channel.isSendable()
            ? (message.channel as SendableChannels)
            : null;
          session.progressMentionContext = message;
          const destination = yield* enqueueRunRequest(session, request);
          return {
            sessionId: session.opencode.sessionId,
            destination,
          } satisfies QueuedMessageRunRequest;
        }),
      routeQuestionInteraction: (interaction) => questions.routeInteraction(interaction),
      invalidate: invalidateSession,
      updateLoadedChannelSettings: (channelId, settings) =>
        getSession(channelId).pipe(
          Effect.flatMap((session) =>
            !session
              ? Effect.void
              : Effect.sync(() => {
                  session.channelSettings = settings;
                }),
          ),
        ),
      requestRunInterrupt: (channelId) =>
        withRestoredSession(channelId, requestSessionRunInterrupt, () =>
          Effect.succeed(interruptFailure("no session for channel")),
        ),
      startCompaction: (channelId, channel) =>
        withRestoredSession(
          channelId,
          (session) =>
            Effect.sync(() => {
              session.progressChannel = channel;
              session.progressMentionContext = null;
            }).pipe(Effect.andThen(idleCompaction.start({ session, channel }))),
          () =>
            Effect.succeed({
              type: "rejected",
              message: "No OpenCode session exists in this channel yet.",
            } satisfies IdleCompactionWorkflowStartResult),
        ),
      requestCompactionInterrupt: (channelId) =>
        withRestoredSession(
          channelId,
          (session) => idleCompaction.requestInterrupt({ session }),
          () =>
            Effect.succeed({
              type: "failed",
              message: "No active OpenCode run or compaction is running in this channel.",
            } satisfies IdleCompactionWorkflowInterruptResult),
        ),
      shutdown,
    } satisfies SessionRuntimeShape);
  }),
);
