import type { Interaction, Message, SendableChannels } from "discord.js";
import { Effect, FiberSet, FileSystem, Layer, Path, Queue, Ref, Result, ServiceMap } from "effect";

import { AppConfig } from "@/config.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards } from "@/discord/info-card.ts";
import { sendFinalResponse, startTypingLoop } from "@/discord/messages.ts";
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
import { createEventHandler } from "@/sessions/event-handler.ts";
import { coordinateActiveRunPrompts } from "@/sessions/run/prompt-coordinator.ts";
import { runProgressWorker } from "@/sessions/run/progress.ts";
import {
  applyQuestionSignals,
  questionTypingAction,
  runQuestionTypingAction,
  type QuestionWorkflowSignal,
} from "@/sessions/question/question-run-state.ts";
import {
  makeQuestionRuntime,
  QuestionRuntime,
  QuestionSessionLookup,
  type QuestionRuntimeShape,
  type RoutedQuestionSignals,
} from "@/sessions/question/question-runtime.ts";
import { enqueueRunRequest, type RunRequestDestination } from "@/sessions/request-routing.ts";
import { executeRunBatch } from "@/sessions/run/run-executor.ts";
import { takeQueuedRunBatch } from "@/sessions/run/run-batch.ts";
import {
  buildSessionCreateSpec,
  type ActiveRun,
  type ChannelSession,
  type RunRequest,
} from "@/sessions/session.ts";
import { createSessionShutdown } from "@/sessions/session-shutdown.ts";
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
    const questionTypingPausedRef = yield* Ref.make(new Set<string>());
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

    const sendErrorReply = (message: Message, title: string, error: unknown) =>
      Effect.promise(() =>
        message.reply({
          content: formatErrorResponse(title, formatError(error)),
          allowedMentions: { repliedUser: false, parse: [] },
        }),
      );

    const sendRunFailure = (message: Message, error: unknown) =>
      sendErrorReply(message, "## ❌ Opencode failed", error);

    const sendQuestionUiFailure = (message: Message, error: unknown) =>
      sendErrorReply(message, "## ❌ Failed to show questions", error);

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
    const questions = yield* makeQuestionRuntime(sendQuestionUiFailure).pipe(
      Effect.provide(
        Layer.mergeAll(
          serviceLayer,
          Layer.succeed(QuestionSessionLookup, {
            getSessionContext,
          }),
        ),
      ),
    );
    questionRuntime = questions;

    const reconcileQuestionTypingForSession = (sessionId: string) =>
      getSessionContext(sessionId).pipe(
        Effect.flatMap((context) => {
          const activeRun = context?.activeRun ?? null;
          if (!activeRun) {
            return Ref.update(questionTypingPausedRef, (current) => {
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
              Ref.modify(questionTypingPausedRef, (current) => {
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

    const applyQuestionWorkflowSignals = (
      sessionId: string,
      signals: ReadonlyArray<QuestionWorkflowSignal>,
    ) =>
      getSessionContext(sessionId).pipe(
        Effect.flatMap((context) => applyQuestionSignals(context?.activeRun ?? null, signals)),
        Effect.andThen(reconcileQuestionTypingForSession(sessionId)),
      );

    const routeQuestionSignals = (effect: Effect.Effect<RoutedQuestionSignals | null, unknown>) =>
      effect.pipe(
        Effect.flatMap((routed) =>
          !routed ? Effect.void : applyQuestionWorkflowSignals(routed.sessionId, routed.signals),
        ),
      );

    const idleCompaction = yield* makeIdleCompactionWorkflow().pipe(Effect.provide(serviceLayer));
    idleCompactionWorkflow = idleCompaction;
    const runtimeServiceLayer = Layer.mergeAll(
      serviceLayer,
      Layer.succeed(QuestionRuntime, questions),
      Layer.succeed(IdleCompactionWorkflow, idleCompaction),
    );

    const eventHandler = createEventHandler(
      getSessionContext,
      (event) => routeQuestionSignals(questions.handleEvent(event)),
      idleCompaction,
      opencode.readPromptResult,
      logger,
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

    const runExecutor = executeRunBatch(
      ({ channelId, session, activeRun, initialRequests, handlePromptCompleted }) =>
        coordinateActiveRunPrompts({
          channelId,
          session,
          activeRun,
          initialRequests,
          awaitIdleCompaction: idleCompaction.awaitCompletion,
          submitPrompt: opencode.submitPrompt,
          handlePromptCompleted,
          logger,
        }),
      runProgressWorker,
      (message) => startTypingLoop(message.channel),
      setActiveRun,
      (sessionId) =>
        questions
          .terminateSession(sessionId)
          .pipe(Effect.flatMap((signals) => applyQuestionWorkflowSignals(sessionId, signals))),
      (session, responseMessage) =>
        ensureSessionHealth(
          session,
          responseMessage,
          "run failed with unhealthy opencode session",
          false,
        ),
      (message, source) =>
        infoCards
          .send(
            message.channel as SendableChannels,
            source === "shutdown" ? "🛑 Run interrupted" : "‼️ Run interrupted",
            source === "shutdown"
              ? "OpenCode stopped the active run in this channel because the bot is shutting down."
              : "OpenCode stopped the active run in this channel.",
          )
          .pipe(
            Effect.catch((error) =>
              logger.warn("failed to post interrupt info card", {
                channelId: message.channelId,
                error: formatError(error),
              }),
            ),
            Effect.ignore,
          ),
      (message, text) => Effect.promise(() => sendFinalResponse({ message, text })),
      sendRunFailure,
      sendQuestionUiFailure,
      logger,
    );

    const worker = (session: ChannelSession): Effect.Effect<never, never, FsEnv> =>
      Effect.forever(
        takeQueuedRunBatch(session.queue).pipe(
          Effect.flatMap((requests) =>
            Ref.get(shutdownStartedRef).pipe(
              Effect.flatMap((shutdownStarted) =>
                shutdownStarted ? Effect.void : runExecutor(session, requests),
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

    const shutdown = () =>
      createSessionShutdown(
        () =>
          Ref.modify(shutdownStartedRef, (started): readonly [boolean, boolean] => [
            !started,
            true,
          ]),
        () => Ref.get(stateRef),
        (session) => Queue.clear(session.queue).pipe(Effect.asVoid),
        () => FiberSet.clear(fiberSet),
        shutdownSessions,
      )().pipe(Effect.provide(runtimeServiceLayer));

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
      routeQuestionInteraction: (interaction) =>
        routeQuestionSignals(questions.routeInteraction(interaction)).pipe(Effect.asVoid),
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
