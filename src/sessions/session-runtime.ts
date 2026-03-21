import type { Interaction, Message, SendableChannels } from "discord.js";
import { Effect, FiberSet, FileSystem, Layer, Path, Queue, Ref, ServiceMap } from "effect";

import { AppConfig } from "@/config.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards } from "@/discord/info-card.ts";
import { sendFinalResponse, startTypingLoop } from "@/discord/messages.ts";
import { buildSessionSystemAppend } from "@/discord/system-context.ts";
import { OpencodeEventQueue } from "@/opencode/events.ts";
import type { OpencodeServiceShape, SessionHandle } from "@/opencode/service.ts";
import { OpencodeService } from "@/opencode/service.ts";
import {
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
  type QuestionRuntime,
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
  type PersistedChannelSettings,
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
import type { LoggerShape } from "@/util/logging.ts";

export type SessionRegistryState = {
  sessionsByChannelId: Map<string, ChannelSession>;
  sessionsBySessionId: Map<string, ChannelSession>;
  activeRunsBySessionId: Map<string, ActiveRun>;
};

export type SessionContext = {
  session: ChannelSession;
  activeRun: ActiveRun | null;
};

export type SessionActivity = {
  hasActiveRun: boolean;
  hasPendingQuestions: boolean;
  hasIdleCompaction: boolean;
  hasQueuedWork: boolean;
  isBusy: boolean;
};

export type ChannelActivity =
  | { type: "missing" }
  | {
      type: "present";
      activity: SessionActivity;
    };

export type QueuedMessageRunRequest = {
  sessionId: string;
  destination: RunRequestDestination;
};

export type RunInterruptRequestResult =
  | { type: "requested" }
  | { type: "question-pending" }
  | { type: "failed"; error: unknown };

export type SessionRuntimeShape = {
  readLoadedChannelActivity: (channelId: string) => Effect.Effect<ChannelActivity, unknown>;
  readRestoredChannelActivity: (
    channelId: string,
  ) => Effect.Effect<ChannelActivity, unknown, FileSystem.FileSystem | Path.Path>;
  getActiveRunBySessionId: (sessionId: string) => Effect.Effect<ActiveRun | null, unknown>;
  queueMessageRunRequest: (
    message: Message,
    request: RunRequest,
    reason: string,
  ) => Effect.Effect<QueuedMessageRunRequest, unknown, FileSystem.FileSystem | Path.Path>;
  routeQuestionInteraction: (interaction: Interaction) => Effect.Effect<void, unknown>;
  invalidate: (channelId: string, reason: string) => Effect.Effect<boolean, unknown>;
  updateLoadedChannelSettings: (
    channelId: string,
    settings: ChannelSettings,
  ) => Effect.Effect<void>;
  requestRunInterrupt: (
    channelId: string,
  ) => Effect.Effect<RunInterruptRequestResult, unknown, FileSystem.FileSystem | Path.Path>;
  startCompaction: (
    channelId: string,
    channel: SendableChannels,
  ) => Effect.Effect<IdleCompactionWorkflowStartResult, unknown, FileSystem.FileSystem | Path.Path>;
  requestCompactionInterrupt: (
    channelId: string,
  ) => Effect.Effect<
    IdleCompactionWorkflowInterruptResult,
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
  shutdown: () => Effect.Effect<void, unknown>;
};

export class SessionRuntime extends ServiceMap.Service<SessionRuntime, SessionRuntimeShape>()(
  "SessionRuntime",
) {}

type SessionLifecycleDeps = {
  stateRef: Ref.Ref<SessionRegistryState>;
  createOpencodeSession: OpencodeServiceShape["createSession"];
  attachOpencodeSession: OpencodeServiceShape["attachSession"];
  getPersistedSession: (
    channelId: string,
  ) => Effect.Effect<PersistedChannelSession | null, unknown>;
  upsertPersistedSession: (session: PersistedChannelSession) => Effect.Effect<void, unknown>;
  getPersistedChannelSettings: (
    channelId: string,
  ) => Effect.Effect<PersistedChannelSettings | null, unknown>;
  touchPersistedSession: (
    channelId: string,
    lastActivityAt: number,
  ) => Effect.Effect<void, unknown>;
  deletePersistedSession: (channelId: string) => Effect.Effect<void, unknown>;
  isSessionHealthy: OpencodeServiceShape["isHealthy"];
  startWorker: (
    session: ChannelSession,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;
  logger: LoggerShape;
  sessionInstructions: string;
  triggerPhrase: string;
  channelSettingsDefaults: ChannelSettings;
  idleTimeoutMs?: number;
  createSessionPaths: (channelId: string) => Effect.Effect<SessionPaths, unknown>;
  isSessionBusy?: (session: ChannelSession) => Effect.Effect<boolean, unknown>;
  deleteSessionRoot: (rootDir: string) => Effect.Effect<void, unknown>;
};

export const createSessionRegistry = (deps: SessionLifecycleDeps) => {
  const sessionGate = createKeyedSingleflight<string>();

  const registryState = {
    read: <A>(map: (state: SessionRegistryState) => A) =>
      Ref.get(deps.stateRef).pipe(Effect.map(map)),
    updateSession: (
      session: ChannelSession,
      options?: {
        previousSessionId?: string;
        activeRun?: ActiveRun | null;
      },
    ) =>
      Ref.update(deps.stateRef, (current) => {
        const previousSessionId = options?.previousSessionId ?? session.opencode.sessionId;
        const activeRun = options && "activeRun" in options ? options.activeRun : session.activeRun;

        const sessionsByChannelId = new Map(current.sessionsByChannelId);
        sessionsByChannelId.set(session.channelId, session);

        const sessionsBySessionId = new Map(current.sessionsBySessionId);
        sessionsBySessionId.delete(previousSessionId);
        sessionsBySessionId.set(session.opencode.sessionId, session);

        const activeRunsBySessionId = new Map(current.activeRunsBySessionId);
        activeRunsBySessionId.delete(previousSessionId);
        if (activeRun) {
          activeRunsBySessionId.set(session.opencode.sessionId, activeRun);
        }

        return {
          ...current,
          sessionsByChannelId,
          sessionsBySessionId,
          activeRunsBySessionId,
        };
      }),
    deleteSession: (session: ChannelSession) =>
      Ref.update(deps.stateRef, (current) => {
        const sessionsByChannelId = new Map(current.sessionsByChannelId);
        sessionsByChannelId.delete(session.channelId);

        const sessionsBySessionId = new Map(current.sessionsBySessionId);
        sessionsBySessionId.delete(session.opencode.sessionId);

        const activeRunsBySessionId = new Map(current.activeRunsBySessionId);
        activeRunsBySessionId.delete(session.opencode.sessionId);

        return {
          ...current,
          sessionsByChannelId,
          sessionsBySessionId,
          activeRunsBySessionId,
        };
      }),
    getSession: (channelId: string) =>
      registryState.read((state) => state.sessionsByChannelId.get(channelId)),
    getActiveRunBySessionId: (sessionId: string) =>
      registryState.read((state) => state.activeRunsBySessionId.get(sessionId) ?? null),
    getSessionContext: (sessionId: string) =>
      registryState.read((state): SessionContext | null => {
        const session = state.sessionsBySessionId.get(sessionId);
        if (!session) {
          return null;
        }

        return {
          session,
          activeRun: state.activeRunsBySessionId.get(sessionId) ?? null,
        };
      }),
    snapshotSessions: () => registryState.read((state) => [...state.sessionsByChannelId.values()]),
  };

  const loadChannelSettings = (channelId: string) =>
    deps
      .getPersistedChannelSettings(channelId)
      .pipe(
        Effect.map((persisted) =>
          persisted
            ? resolveChannelSettings(deps.channelSettingsDefaults, persisted)
            : { ...deps.channelSettingsDefaults },
        ),
      );

  const { getSession, getActiveRunBySessionId, getSessionContext } = registryState;

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
    }).pipe(Effect.andThen(registryState.updateSession(session)));

  const replaceSessionHandle = (
    session: ChannelSession,
    replacement: ChannelSession["opencode"],
  ) => {
    const previousSessionId = session.opencode.sessionId;
    return Effect.sync(() => {
      session.opencode = replacement;
    }).pipe(
      Effect.andThen(
        registryState.updateSession(session, {
          previousSessionId,
          activeRun: null,
        }),
      ),
    );
  };

  const withSessionGate = <A, R>(
    channelId: string,
    task: Effect.Effect<A, unknown, R>,
  ): Effect.Effect<A, unknown, R> => sessionGate.waitAndRetry(channelId, task);

  const touchSessionActivity = (session: ChannelSession, at = Date.now()) =>
    Effect.gen(function* () {
      session.lastActivityAt = at;
      yield* deps.touchPersistedSession(session.channelId, at);
    });

  const isSessionBusy = (session: ChannelSession) =>
    session.activeRun
      ? Effect.succeed(true)
      : deps.isSessionBusy
        ? deps.isSessionBusy(session)
        : Effect.succeed(false);

  const activateSession = (
    session: ChannelSession,
    options?: {
      removePersistedOnFailure?: boolean;
    },
  ): Effect.Effect<ChannelSession, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      yield* deps.upsertPersistedSession(toPersistedSession(session));
      yield* registryState.updateSession(session);
      yield* deps.startWorker(session);
      return session;
    }).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          yield* registryState.deleteSession(session);
          yield* session.opencode.close().pipe(Effect.ignore);
          if (options?.removePersistedOnFailure) {
            yield* deps.deletePersistedSession(session.channelId).pipe(Effect.ignore);
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
  }): Effect.Effect<ChannelSession> =>
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
  }): Effect.Effect<ChannelSession, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const createSpec = buildSessionCreateSpec(input);
      const opencodeSession = yield* deps.createOpencodeSession(
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

      yield* deps.logger.info("created channel session", {
        channelId: input.channelId,
        sessionId: opencodeSession.sessionId,
        backend: opencodeSession.backend,
        workdir: input.workdir,
        triggerPhrase: deps.triggerPhrase,
        reason: input.logReason,
      });

      return session;
    }).pipe(
      Effect.onError(() =>
        input.deleteNewRootOnFailure
          ? deps.deleteSessionRoot(input.rootDir).pipe(Effect.ignore)
          : Effect.void,
      ),
    );

  const createSession = (
    message: Message,
  ): Effect.Effect<ChannelSession, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const { rootDir, workdir } = yield* deps.createSessionPaths(message.channelId);
      return yield* Effect.gen(function* () {
        const systemPromptAppend = buildSessionSystemAppend({
          message,
          additionalInstructions: deps.sessionInstructions,
        });
        const channelSettings = yield* loadChannelSettings(message.channelId);
        const now = Date.now();

        return yield* createSessionAt({
          channelId: message.channelId,
          rootDir,
          systemPromptAppend,
          workdir,
          channelSettings,
          createdAt: now,
          lastActivityAt: now,
          removePersistedOnActivationFailure: true,
          deleteNewRootOnFailure: false,
        });
      }).pipe(Effect.onError(() => deps.deleteSessionRoot(rootDir).pipe(Effect.ignore)));
    });

  const attachPersistedSession = (
    channelId: string,
    persisted: PersistedChannelSession,
    lastActivityAt = Date.now(),
  ): Effect.Effect<ChannelSession, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const { workdir } = sessionPathsFromRoot(persisted.rootDir);
      const channelSettings = yield* loadChannelSettings(channelId);

      const opencodeSession = yield* deps.attachOpencodeSession(
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
      yield* deps.logger.info("attached channel session", {
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
  ): Effect.Effect<ChannelSession | A, unknown, R> =>
    Effect.gen(function* () {
      const existing = yield* getSession(channelId);
      if (existing) {
        return yield* touchSessionActivity(existing).pipe(Effect.as(existing));
      }

      return yield* withSessionGate(
        channelId,
        Effect.gen(function* () {
          const current = yield* getSession(channelId);
          return current
            ? yield* touchSessionActivity(current).pipe(Effect.as(current))
            : yield* onMissing();
        }),
      );
    });

  const closeSessionResources = (session: ChannelSession) =>
    Queue.shutdown(session.queue).pipe(
      Effect.ignore,
      Effect.andThen(session.opencode.close().pipe(Effect.ignore)),
    );

  const unloadSession = (session: ChannelSession) =>
    registryState.deleteSession(session).pipe(Effect.andThen(closeSessionResources(session)));

  const restoreOrCreateSession = (
    message: Message,
  ): Effect.Effect<ChannelSession, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const persisted = yield* deps.getPersistedSession(message.channelId);
      if (!persisted) {
        return yield* createSession(message);
      }

      const now = Date.now();
      const attached = yield* attachPersistedSession(message.channelId, persisted, now).pipe(
        Effect.result,
      );
      if (attached._tag === "Success") {
        return attached.success;
      }

      yield* deps.logger.warn("failed to attach persisted channel session", {
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
        channelSettings: yield* loadChannelSettings(message.channelId),
        createdAt: persisted.createdAt,
        lastActivityAt: now,
        logReason: "attach failed; created replacement session",
        removePersistedOnActivationFailure: false,
        deleteNewRootOnFailure: false,
      });
    });

  const createOrGetSession = (
    message: Message,
  ): Effect.Effect<ChannelSession, unknown, FileSystem.FileSystem | Path.Path> =>
    withExistingOrGatedSession(message.channelId, () => restoreOrCreateSession(message)).pipe(
      Effect.map((session) => session as ChannelSession),
    );

  const getOrRestoreSession = (
    channelId: string,
  ): Effect.Effect<ChannelSession | null, unknown, FileSystem.FileSystem | Path.Path> =>
    withExistingOrGatedSession(channelId, () =>
      deps
        .getPersistedSession(channelId)
        .pipe(
          Effect.flatMap((persisted) =>
            persisted ? attachPersistedSession(channelId, persisted) : Effect.succeed(null),
          ),
        ),
    ).pipe(Effect.map((session) => session as ChannelSession | null));

  const recreateSession = (
    session: ChannelSession,
    message: Message,
    reason: string,
  ): Effect.Effect<ChannelSession, unknown, FileSystem.FileSystem | Path.Path> =>
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
        const replacement = yield* deps.createOpencodeSession(
          current.workdir,
          `Discord #${message.channelId}`,
          current.systemPromptAppend,
        );
        yield* replaceSessionHandle(current, replacement);
        yield* deps.upsertPersistedSession(toPersistedSession(current));
        yield* previous.close().pipe(Effect.ignore);
        yield* deps.logger.warn("recovered channel session", {
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
  ): Effect.Effect<ChannelSession, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      if (allowBusySession && session.activeRun) {
        return session;
      }

      const healthy = yield* deps.isSessionHealthy(session.opencode);
      if (healthy) {
        return session;
      }

      return yield* recreateSession(session, message, reason);
    });

  const closeExpiredSessions = (now = Date.now()) =>
    registryState.snapshotSessions().pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(
          sessions,
          (session) =>
            Effect.gen(function* () {
              const busy = yield* isSessionBusy(session);
              if (
                busy ||
                !deps.idleTimeoutMs ||
                now - session.lastActivityAt < deps.idleTimeoutMs
              ) {
                return;
              }

              yield* unloadSession(session);
              yield* deps.logger.info("closed idle channel session", {
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
        const persisted = yield* deps.getPersistedSession(channelId);

        if (loadedSession && (yield* isSessionBusy(loadedSession))) {
          return false;
        }

        if (loadedSession) {
          yield* unloadSession(loadedSession);
        }

        yield* deps.deletePersistedSession(channelId).pipe(Effect.ignore);

        if (loadedSession) {
          yield* deps.logger.info("invalidated loaded channel session", {
            channelId,
            sessionId: loadedSession.opencode.sessionId,
            workdir: loadedSession.workdir,
            reason,
          });
          return true;
        }

        if (persisted) {
          yield* deps.logger.info("invalidated persisted channel session", {
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
    registryState.snapshotSessions().pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(sessions, unloadSession, {
          concurrency: "unbounded",
          discard: true,
        }),
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
};

export const SessionRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const logger = yield* Logger;
    const config = yield* AppConfig;
    const fs = yield* FileSystem.FileSystem;
    const infoCards = yield* InfoCards;
    const opencode = yield* OpencodeService;
    const eventQueue = yield* OpencodeEventQueue;
    const statePersistence = yield* StatePersistence;
    const stateRef = yield* Ref.make<SessionRegistryState>({
      sessionsByChannelId: new Map(),
      sessionsBySessionId: new Map(),
      activeRunsBySessionId: new Map(),
    });
    const shutdownStartedRef = yield* Ref.make(false);
    const questionTypingPausedRef = yield* Ref.make(new Set<string>());
    const fiberSet = yield* FiberSet.make();
    const statePaths = resolveStatePaths(config.stateDir);
    const channelSettingsDefaults = defaultChannelSettings(config);
    let idleCompactionWorkflow: IdleCompactionWorkflowShape | null = null;
    let questionRuntime: QuestionRuntime | null = null;

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

    const sessionLifecycle = createSessionRegistry({
      stateRef,
      createOpencodeSession: opencode.createSession,
      attachOpencodeSession: opencode.attachSession,
      getPersistedSession: statePersistence.getSession,
      upsertPersistedSession: statePersistence.upsertSession,
      getPersistedChannelSettings: statePersistence.getChannelSettings,
      touchPersistedSession: statePersistence.touchSession,
      deletePersistedSession: statePersistence.deleteSession,
      isSessionHealthy: opencode.isHealthy,
      startWorker: (session) =>
        FiberSet.run(fiberSet, { startImmediately: true })(worker(session)).pipe(Effect.asVoid),
      logger,
      sessionInstructions: config.sessionInstructions,
      triggerPhrase: config.triggerPhrase,
      channelSettingsDefaults,
      idleTimeoutMs: config.sessionIdleTimeoutMs,
      createSessionPaths: (channelId) =>
        Effect.gen(function* () {
          const sessionPaths = sessionPathsForChannel(statePaths.sessionsRootDir, channelId);
          const { workdir } = sessionPaths;
          yield* fs.makeDirectory(workdir, { recursive: true });
          return sessionPaths;
        }),
      deleteSessionRoot: (rootDir) =>
        fs.remove(rootDir, { recursive: true, force: true }).pipe(Effect.ignore),
      isSessionBusy,
    });
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

    const questions = yield* makeQuestionRuntime({
      getSessionContext,
      replyToQuestion: opencode.replyToQuestion,
      rejectQuestion: opencode.rejectQuestion,
      sendQuestionUiFailure,
      logger,
      formatError,
    });
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

    const serviceLayer = Layer.mergeAll(
      Layer.succeed(Logger, logger),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(OpencodeService, opencode),
    );
    const idleCompaction = yield* makeIdleCompactionWorkflow().pipe(Effect.provide(serviceLayer));
    idleCompactionWorkflow = idleCompaction;

    const eventHandler = createEventHandler({
      getSessionContext,
      handleQuestionEvent: (event) => routeQuestionSignals(questions.handleEvent(event)),
      idleCompactionWorkflow: idleCompaction,
      readPromptResult: opencode.readPromptResult,
      logger,
      formatError,
    });

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

    const runExecutor = executeRunBatch({
      runPrompts: ({ channelId, session, activeRun, initialRequests, handlePromptCompleted }) =>
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
      startTyping: (message) => startTypingLoop(message.channel),
      setActiveRun,
      terminateQuestionBatches: (sessionId) =>
        questions
          .terminateSession(sessionId)
          .pipe(Effect.flatMap((signals) => applyQuestionWorkflowSignals(sessionId, signals))),
      ensureSessionHealthAfterFailure: (session, responseMessage) =>
        ensureSessionHealth(
          session,
          responseMessage,
          "run failed with unhealthy opencode session",
          false,
        ),
      sendRunInterruptedInfo: (message, source) =>
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
      sendFinalResponse: (message, text) =>
        Effect.promise(() => sendFinalResponse({ message, text })),
      sendRunFailure,
      sendQuestionUiFailure,
      logger,
      formatError,
    });

    const worker = (
      session: ChannelSession,
    ): Effect.Effect<never, never, FileSystem.FileSystem | Path.Path> =>
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

    const shutdown = createSessionShutdown({
      startShutdown: () =>
        Ref.modify(shutdownStartedRef, (started): readonly [boolean, boolean] => [!started, true]),
      getState: () => Ref.get(stateRef),
      questionRuntime: questions,
      idleCompactionWorkflow: idleCompaction,
      opencode,
      logger,
      infoCards,
      drainQueuedRunRequestsForShutdown: (session) =>
        Queue.clear(session.queue).pipe(Effect.asVoid),
      interruptSessionWorkers: () => FiberSet.clear(fiberSet),
      shutdownSessions,
      formatError,
    });

    const readSessionActivity = (
      session: ChannelSession,
    ): Effect.Effect<SessionActivity, unknown> =>
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
    ): Effect.Effect<ChannelActivity, unknown, R> =>
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

    const requestSessionRunInterrupt = (
      session: ChannelSession,
    ): Effect.Effect<RunInterruptRequestResult, unknown> =>
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
      onPresent: (
        session: ChannelSession,
      ) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
      onMissing: () => Effect.Effect<A>,
    ): Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path> =>
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
