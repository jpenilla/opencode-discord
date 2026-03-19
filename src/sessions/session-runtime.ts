import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { Interaction, Message, SendableChannels } from "discord.js";
import { Deferred, Effect, FiberSet, Layer, Option, Queue, Ref, ServiceMap } from "effect";

import { AppConfig } from "@/config.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards } from "@/discord/info-cards.ts";
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
} from "@/sessions/idle-compaction-workflow.ts";
import { createEventHandler } from "@/sessions/event-handler.ts";
import { coordinateActiveRunPrompts } from "@/sessions/prompt-coordinator.ts";
import { runProgressWorker } from "@/sessions/progress.ts";
import {
  type QuestionWorkflowEvent,
  type QuestionWorkflowSignal,
} from "@/sessions/question-coordinator.ts";
import { makeQuestionRuntime, type QuestionRuntime } from "@/sessions/question-runtime.ts";
import { enqueueRunRequest, type RunRequestDestination } from "@/sessions/request-routing.ts";
import { executeRunBatch } from "@/sessions/run-executor.ts";
import { takeQueuedRunBatch } from "@/sessions/run-batch.ts";
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
import { sessionRootDir, sessionWorkdirFromRoot } from "@/state/paths.ts";
import { resolveStatePaths } from "@/state/paths.ts";
import { SessionStore, type PersistedChannelSession } from "@/state/store.ts";
import { formatError } from "@/util/errors.ts";
import { Logger } from "@/util/logging.ts";
import type { LoggerShape } from "@/util/logging.ts";

export type SessionGate = Deferred.Deferred<void, never>;

export type SessionLifecycleState = {
  sessionsByChannelId: Map<string, ChannelSession>;
  sessionsBySessionId: Map<string, ChannelSession>;
  activeRunsBySessionId: Map<string, ActiveRun>;
  gatesByChannelId: Map<string, SessionGate>;
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
  readRestoredChannelActivity: (channelId: string) => Effect.Effect<ChannelActivity, unknown>;
  getActiveRunBySessionId: (sessionId: string) => Effect.Effect<ActiveRun | null, unknown>;
  queueMessageRunRequest: (
    message: Message,
    request: RunRequest,
    reason: string,
  ) => Effect.Effect<QueuedMessageRunRequest, unknown>;
  routeQuestionInteraction: (interaction: Interaction) => Effect.Effect<void, unknown>;
  invalidate: (channelId: string, reason: string) => Effect.Effect<boolean, unknown>;
  updateLoadedChannelSettings: (
    channelId: string,
    settings: ChannelSettings,
  ) => Effect.Effect<void>;
  requestRunInterrupt: (channelId: string) => Effect.Effect<RunInterruptRequestResult, unknown>;
  startCompaction: (
    channelId: string,
    channel: SendableChannels,
  ) => Effect.Effect<IdleCompactionWorkflowStartResult, unknown>;
  requestCompactionInterrupt: (
    channelId: string,
  ) => Effect.Effect<IdleCompactionWorkflowInterruptResult, unknown>;
  shutdown: () => Effect.Effect<void, unknown>;
};

export type SessionChannelBridgeShape = Pick<
  SessionRuntimeShape,
  | "readLoadedChannelActivity"
  | "readRestoredChannelActivity"
  | "queueMessageRunRequest"
  | "routeQuestionInteraction"
  | "invalidate"
  | "updateLoadedChannelSettings"
  | "requestRunInterrupt"
  | "startCompaction"
  | "requestCompactionInterrupt"
  | "shutdown"
>;

export class SessionChannelBridge extends ServiceMap.Service<
  SessionChannelBridge,
  SessionChannelBridgeShape
>()("SessionChannelBridge") {}

export type SessionRunAccessShape = Pick<SessionRuntimeShape, "getActiveRunBySessionId">;

export class SessionRunAccess extends ServiceMap.Service<SessionRunAccess, SessionRunAccessShape>()(
  "SessionRunAccess",
) {}

export class SessionRuntime extends ServiceMap.Service<SessionRuntime, SessionRuntimeShape>()(
  "SessionRuntime",
) {}

type SessionGateDecision = {
  gate: SessionGate;
  owner: boolean;
};

type SessionPaths = {
  rootDir: string;
  workdir: string;
};

type SessionLifecycleDeps<State extends SessionLifecycleState> = {
  stateRef: Ref.Ref<State>;
  createOpencodeSession: (
    workdir: string,
    title: string,
    systemPromptAppend?: string,
  ) => Effect.Effect<SessionHandle, unknown>;
  attachOpencodeSession: (
    workdir: string,
    sessionId: string,
    systemPromptAppend?: string,
  ) => Effect.Effect<SessionHandle, unknown>;
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
  startWorker: (session: ChannelSession) => Effect.Effect<void, unknown>;
  logger: LoggerShape;
  sessionInstructions: string;
  triggerPhrase: string;
  channelSettingsDefaults: ChannelSettings;
  idleTimeoutMs?: number;
  sessionsRootDir: string;
  isSessionBusy?: (session: ChannelSession) => Effect.Effect<boolean, unknown>;
  createSessionPaths?: (channelId: string) => Effect.Effect<SessionPaths, unknown>;
  deleteSessionRoot?: (rootDir: string) => Effect.Effect<void, unknown>;
};

const defaultCreateSessionPaths = (sessionsRootDir: string, channelId: string) =>
  Effect.promise(async () => {
    const rootDir = sessionRootDir(sessionsRootDir, channelId);
    const workdir = sessionWorkdirFromRoot(rootDir);
    await mkdir(workdir, { recursive: true });
    return {
      rootDir,
      workdir,
    };
  });

const defaultDeleteSessionRoot = (rootDir: string) =>
  Effect.promise(() => rm(resolve(rootDir), { recursive: true, force: true })).pipe(Effect.ignore);

export const createSessionLifecycle = <State extends SessionLifecycleState>(
  deps: SessionLifecycleDeps<State>,
) => {
  const createSessionPaths =
    deps.createSessionPaths ??
    ((channelId: string) => defaultCreateSessionPaths(deps.sessionsRootDir, channelId));
  const deleteSessionRoot = deps.deleteSessionRoot ?? defaultDeleteSessionRoot;
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

  const getSession = (channelId: string) =>
    Ref.get(deps.stateRef).pipe(Effect.map((state) => state.sessionsByChannelId.get(channelId)));

  const getActiveRunBySessionId = (sessionId: string) =>
    Ref.get(deps.stateRef).pipe(
      Effect.map((state) => state.activeRunsBySessionId.get(sessionId) ?? null),
    );

  const getSessionContext = (sessionId: string) =>
    Ref.get(deps.stateRef).pipe(
      Effect.map((state): SessionContext | null => {
        const session = state.sessionsBySessionId.get(sessionId);
        if (!session) {
          return null;
        }
        return {
          session,
          activeRun: state.activeRunsBySessionId.get(sessionId) ?? null,
        };
      }),
    );

  const toPersistedSession = (session: ChannelSession): PersistedChannelSession => ({
    channelId: session.channelId,
    opencodeSessionId: session.opencode.sessionId,
    rootDir: session.rootDir,
    systemPromptAppend: session.systemPromptAppend,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
  });

  const putSession = (session: ChannelSession) =>
    Ref.update(deps.stateRef, (current) => {
      const sessionsByChannelId = new Map(current.sessionsByChannelId);
      sessionsByChannelId.set(session.channelId, session);
      const sessionsBySessionId = new Map(current.sessionsBySessionId);
      sessionsBySessionId.set(session.opencode.sessionId, session);
      return {
        ...current,
        sessionsByChannelId,
        sessionsBySessionId,
      };
    });

  const deleteSession = (session: ChannelSession) =>
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
    });

  const setActiveRun = (session: ChannelSession, activeRun: ActiveRun | null) =>
    Ref.update(deps.stateRef, (current) => {
      session.activeRun = activeRun;

      const sessionsByChannelId = new Map(current.sessionsByChannelId);
      sessionsByChannelId.set(session.channelId, session);
      const sessionsBySessionId = new Map(current.sessionsBySessionId);
      sessionsBySessionId.set(session.opencode.sessionId, session);

      const activeRunsBySessionId = new Map(current.activeRunsBySessionId);
      if (activeRun) {
        activeRunsBySessionId.set(session.opencode.sessionId, activeRun);
      } else {
        activeRunsBySessionId.delete(session.opencode.sessionId);
      }

      return {
        ...current,
        sessionsByChannelId,
        sessionsBySessionId,
        activeRunsBySessionId,
      };
    });

  const replaceSessionHandle = (session: ChannelSession, replacement: ChannelSession["opencode"]) =>
    Ref.update(deps.stateRef, (current) => {
      const previousSessionId = session.opencode.sessionId;
      session.opencode = replacement;

      const sessionsByChannelId = new Map(current.sessionsByChannelId);
      sessionsByChannelId.set(session.channelId, session);
      const sessionsBySessionId = new Map(current.sessionsBySessionId);
      sessionsBySessionId.delete(previousSessionId);
      sessionsBySessionId.set(replacement.sessionId, session);

      const activeRunsBySessionId = new Map(current.activeRunsBySessionId);
      activeRunsBySessionId.delete(previousSessionId);

      return {
        ...current,
        sessionsByChannelId,
        sessionsBySessionId,
        activeRunsBySessionId,
      };
    });

  const clearSessionGate = (channelId: string, gate: SessionGate) =>
    Ref.update(deps.stateRef, (current) => {
      if (current.gatesByChannelId.get(channelId) !== gate) {
        return current;
      }

      const gatesByChannelId = new Map(current.gatesByChannelId);
      gatesByChannelId.delete(channelId);
      return {
        ...current,
        gatesByChannelId,
      };
    });

  const withSessionGate = <A>(
    channelId: string,
    task: Effect.Effect<A, unknown>,
  ): Effect.Effect<A, unknown> =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void, never>();
      const { gate: currentGate, owner } = yield* Ref.modify(
        deps.stateRef,
        (current): readonly [SessionGateDecision, State] => {
          const existing = current.gatesByChannelId.get(channelId);
          if (existing) {
            return [{ gate: existing, owner: false }, current];
          }

          const gatesByChannelId = new Map(current.gatesByChannelId);
          gatesByChannelId.set(channelId, gate);
          return [
            { gate, owner: true },
            {
              ...current,
              gatesByChannelId,
            },
          ];
        },
      );

      if (owner) {
        return yield* task.pipe(
          Effect.ensuring(
            clearSessionGate(channelId, currentGate).pipe(
              Effect.andThen(Deferred.succeed(currentGate, undefined).pipe(Effect.ignore)),
            ),
          ),
        );
      }

      yield* Deferred.await(currentGate);
      return yield* withSessionGate(channelId, task);
    });

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
  ): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      yield* deps.upsertPersistedSession(toPersistedSession(session));
      yield* putSession(session);
      yield* deps.startWorker(session);
      return session;
    }).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          yield* deleteSession(session);
          yield* session.opencode.close().pipe(Effect.ignore);
          if (options?.removePersistedOnFailure) {
            yield* deps.deletePersistedSession(session.channelId).pipe(Effect.ignore);
          }
        }).pipe(Effect.ignore),
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
  }): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      const sessionCreateSpec = buildSessionCreateSpec({
        channelId: input.channelId,
        workdir: input.workdir,
        systemPromptAppend: input.systemPromptAppend,
      });

      const opencodeSession = yield* deps.createOpencodeSession(
        sessionCreateSpec.workdir,
        sessionCreateSpec.title,
        sessionCreateSpec.systemPromptAppend,
      );
      const queue = yield* Queue.unbounded<RunRequest>();

      const session: ChannelSession = {
        channelId: input.channelId,
        opencode: opencodeSession,
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
      };

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
          ? deleteSessionRoot(input.rootDir).pipe(Effect.ignore)
          : Effect.void,
      ),
    );

  const createSession = (message: Message): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      const systemPromptAppend = buildSessionSystemAppend({
        message,
        additionalInstructions: deps.sessionInstructions,
      });
      const { rootDir, workdir } = yield* createSessionPaths(message.channelId);
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
        deleteNewRootOnFailure: true,
      });
    });

  const attachPersistedSession = (
    channelId: string,
    persisted: PersistedChannelSession,
    lastActivityAt = Date.now(),
  ): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      const workdir = sessionWorkdirFromRoot(persisted.rootDir);
      const channelSettings = yield* loadChannelSettings(channelId);

      const opencodeSession = yield* deps.attachOpencodeSession(
        workdir,
        persisted.opencodeSessionId,
        persisted.systemPromptAppend,
      );
      const queue = yield* Queue.unbounded<RunRequest>();
      const session: ChannelSession = {
        channelId,
        opencode: opencodeSession,
        systemPromptAppend: persisted.systemPromptAppend,
        rootDir: persisted.rootDir,
        workdir,
        createdAt: persisted.createdAt,
        lastActivityAt,
        channelSettings,
        progressChannel: null,
        progressMentionContext: null,
        emittedCompactionSummaryMessageIds: new Set<string>(),
        queue,
        activeRun: null,
      };

      yield* activateSession(session);
      yield* deps.logger.info("attached channel session", {
        channelId,
        sessionId: opencodeSession.sessionId,
        backend: opencodeSession.backend,
        workdir,
      });
      return session;
    });

  const restoreOrCreateSession = (message: Message): Effect.Effect<ChannelSession, unknown> =>
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
        workdir: sessionWorkdirFromRoot(persisted.rootDir),
        systemPromptAppend: persisted.systemPromptAppend,
        channelSettings: yield* loadChannelSettings(message.channelId),
        createdAt: persisted.createdAt,
        lastActivityAt: now,
        logReason: "attach failed; created replacement session",
        removePersistedOnActivationFailure: false,
        deleteNewRootOnFailure: false,
      });
    });

  const createOrGetSession = (message: Message): Effect.Effect<ChannelSession, unknown> =>
    Effect.gen(function* () {
      const existing = yield* getSession(message.channelId);
      if (existing) {
        yield* touchSessionActivity(existing);
        return existing;
      }

      return yield* withSessionGate(
        message.channelId,
        Effect.gen(function* () {
          const current = yield* getSession(message.channelId);
          if (current) {
            yield* touchSessionActivity(current);
            return current;
          }
          return yield* restoreOrCreateSession(message);
        }),
      );
    });

  const getOrRestoreSession = (channelId: string): Effect.Effect<ChannelSession | null, unknown> =>
    Effect.gen(function* () {
      const existing = yield* getSession(channelId);
      if (existing) {
        yield* touchSessionActivity(existing);
        return existing;
      }

      const persisted = yield* deps.getPersistedSession(channelId);
      if (!persisted) {
        return null;
      }

      return yield* withSessionGate(
        channelId,
        Effect.gen(function* () {
          const current = yield* getSession(channelId);
          if (current) {
            yield* touchSessionActivity(current);
            return current;
          }
          return yield* attachPersistedSession(channelId, persisted);
        }),
      );
    });

  const recreateSession = (
    session: ChannelSession,
    message: Message,
    reason: string,
  ): Effect.Effect<ChannelSession, unknown> =>
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
        const sessionCreateSpec = buildSessionCreateSpec({
          channelId: message.channelId,
          workdir: current.workdir,
          systemPromptAppend: current.systemPromptAppend,
        });
        const replacement = yield* deps.createOpencodeSession(
          sessionCreateSpec.workdir,
          sessionCreateSpec.title,
          sessionCreateSpec.systemPromptAppend,
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
  ): Effect.Effect<ChannelSession, unknown> =>
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
    Ref.get(deps.stateRef).pipe(
      Effect.flatMap((state) =>
        Effect.forEach(
          state.sessionsByChannelId.values(),
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

              yield* deleteSession(session);
              yield* Queue.shutdown(session.queue).pipe(Effect.ignore);
              yield* session.opencode.close().pipe(Effect.ignore);
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
          yield* deleteSession(loadedSession);
          yield* Queue.shutdown(loadedSession.queue).pipe(Effect.ignore);
          yield* loadedSession.opencode.close().pipe(Effect.ignore);
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
            workdir: sessionWorkdirFromRoot(persisted.rootDir),
            reason,
          });
        }

        return true;
      }),
    );

  const shutdownSessions = () =>
    Ref.get(deps.stateRef).pipe(
      Effect.flatMap((state) =>
        Effect.forEach(
          state.sessionsByChannelId.values(),
          (session) =>
            deleteSession(session).pipe(
              Effect.andThen(Queue.shutdown(session.queue).pipe(Effect.ignore)),
              Effect.andThen(session.opencode.close().pipe(Effect.ignore)),
            ),
          { concurrency: "unbounded", discard: true },
        ),
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

export const makeSessionRuntime = (deps: {
  getLoaded: (channelId: string) => Effect.Effect<ChannelSession | null, unknown>;
  getOrRestore: (channelId: string) => Effect.Effect<ChannelSession | null, unknown>;
  getActiveRunBySessionId: SessionRuntimeShape["getActiveRunBySessionId"];
  queueMessageRunRequest: SessionRuntimeShape["queueMessageRunRequest"];
  routeQuestionInteraction: SessionRuntimeShape["routeQuestionInteraction"];
  invalidate: SessionRuntimeShape["invalidate"];
  updateLoadedChannelSettings: SessionRuntimeShape["updateLoadedChannelSettings"];
  interruptSession: (session: ChannelSession) => Effect.Effect<void, unknown>;
  setRunInterruptRequested: (
    activeRun: ActiveRun,
    requested: boolean,
    source?: "user" | "shutdown" | null,
  ) => Effect.Effect<void>;
  isSessionBusy: (session: ChannelSession) => Effect.Effect<boolean, unknown>;
  hasPendingQuestions: (sessionId: string) => Effect.Effect<boolean, unknown>;
  hasIdleCompaction: (sessionId: string) => Effect.Effect<boolean, unknown>;
  startCompaction: (
    channelId: string,
    channel: SendableChannels,
  ) => Effect.Effect<IdleCompactionWorkflowStartResult, unknown>;
  requestCompactionInterrupt: (
    channelId: string,
  ) => Effect.Effect<IdleCompactionWorkflowInterruptResult, unknown>;
  shutdown: SessionRuntimeShape["shutdown"];
}): SessionRuntimeShape => {
  const readSessionActivity = (session: ChannelSession): Effect.Effect<SessionActivity, unknown> =>
    Effect.all({
      hasPendingQuestions: deps.hasPendingQuestions(session.opencode.sessionId),
      hasIdleCompaction: deps.hasIdleCompaction(session.opencode.sessionId),
      hasQueuedWork: Queue.size(session.queue).pipe(Effect.map((size) => size > 0)),
      isBusy: deps.isSessionBusy(session),
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

  const toChannelActivity = (
    session: ChannelSession | null,
  ): Effect.Effect<ChannelActivity, unknown> =>
    !session
      ? Effect.succeed({ type: "missing" } satisfies ChannelActivity)
      : readSessionActivity(session).pipe(
          Effect.map(
            (activity) =>
              ({
                type: "present",
                activity,
              }) satisfies ChannelActivity,
          ),
        );

  return {
    readLoadedChannelActivity: (channelId) =>
      deps.getLoaded(channelId).pipe(Effect.flatMap(toChannelActivity)),
    readRestoredChannelActivity: (channelId) =>
      deps.getOrRestore(channelId).pipe(Effect.flatMap(toChannelActivity)),
    getActiveRunBySessionId: deps.getActiveRunBySessionId,
    queueMessageRunRequest: deps.queueMessageRunRequest,
    routeQuestionInteraction: deps.routeQuestionInteraction,
    invalidate: deps.invalidate,
    updateLoadedChannelSettings: deps.updateLoadedChannelSettings,
    requestRunInterrupt: (channelId) =>
      deps.getOrRestore(channelId).pipe(
        Effect.flatMap((session) =>
          !session
            ? Effect.succeed({
                type: "failed",
                error: new Error("no session for channel"),
              } satisfies RunInterruptRequestResult)
            : Effect.gen(function* () {
                const activeRun = session.activeRun;
                if (!activeRun) {
                  return {
                    type: "failed",
                    error: new Error("no active run for session"),
                  } satisfies RunInterruptRequestResult;
                }

                yield* deps.setRunInterruptRequested(activeRun, true);
                const interruptResult = yield* deps.interruptSession(session).pipe(Effect.result);
                if (interruptResult._tag === "Failure") {
                  yield* deps.setRunInterruptRequested(activeRun, false);
                  return {
                    type: "failed",
                    error: interruptResult.failure,
                  } satisfies RunInterruptRequestResult;
                }

                const updatedActivity = yield* readSessionActivity(session);
                if (updatedActivity.hasPendingQuestions) {
                  yield* deps.setRunInterruptRequested(activeRun, false);
                  return {
                    type: "question-pending",
                  } satisfies RunInterruptRequestResult;
                }

                return {
                  type: "requested",
                } satisfies RunInterruptRequestResult;
              }),
        ),
      ),
    startCompaction: deps.startCompaction,
    requestCompactionInterrupt: deps.requestCompactionInterrupt,
    shutdown: deps.shutdown,
  };
};

type SessionRuntimeLayerState = SessionLifecycleState;

const createSessionRuntimeState = (): SessionRuntimeLayerState => ({
  sessionsByChannelId: new Map(),
  sessionsBySessionId: new Map(),
  activeRunsBySessionId: new Map(),
  gatesByChannelId: new Map(),
});

export const SessionRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const logger = yield* Logger;
    const config = yield* AppConfig;
    const infoCards = yield* InfoCards;
    const opencode = yield* OpencodeService;
    const eventQueue = yield* OpencodeEventQueue;
    const sessionStore = yield* SessionStore;
    const stateRef = yield* Ref.make(createSessionRuntimeState());
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

    const sessionLifecycle = createSessionLifecycle({
      stateRef,
      createOpencodeSession: opencode.createSession,
      attachOpencodeSession: opencode.attachSession,
      getPersistedSession: sessionStore.getSession,
      upsertPersistedSession: sessionStore.upsertSession,
      getPersistedChannelSettings: sessionStore.getChannelSettings,
      touchPersistedSession: sessionStore.touchSession,
      deletePersistedSession: sessionStore.deleteSession,
      isSessionHealthy: opencode.isHealthy,
      startWorker: (session) =>
        FiberSet.run(fiberSet, { startImmediately: true })(worker(session)).pipe(Effect.asVoid),
      logger,
      sessionInstructions: config.sessionInstructions,
      triggerPhrase: config.triggerPhrase,
      channelSettingsDefaults,
      idleTimeoutMs: config.sessionIdleTimeoutMs,
      sessionsRootDir: statePaths.sessionsRootDir,
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

    const hasPendingQuestions = (sessionId: string) => questions.hasPendingQuestions(sessionId);

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

          return hasPendingQuestions(sessionId).pipe(
            Effect.flatMap((pending) =>
              Ref.modify(questionTypingPausedRef, (current) => {
                const wasPaused = current.has(sessionId);
                if (pending === wasPaused) {
                  return [{ pending, wasPaused }, current] as const;
                }

                const next = new Set(current);
                if (pending) {
                  next.add(sessionId);
                } else {
                  next.delete(sessionId);
                }
                return [{ pending, wasPaused }, next] as const;
              }).pipe(
                Effect.flatMap(({ pending, wasPaused }) =>
                  pending
                    ? wasPaused
                      ? Effect.void
                      : Effect.promise(() => activeRun.typing.pause()).pipe(
                          Effect.timeoutOption("1 second"),
                          Effect.flatMap((result) =>
                            Option.isSome(result)
                              ? Effect.void
                              : logger.warn(
                                  "typing pause timed out while question prompt was active",
                                  {
                                    channelId: activeRun.originMessage.channelId,
                                    sessionId,
                                  },
                                ),
                          ),
                        )
                    : wasPaused
                      ? activeRun.questionOutcome._tag !== "none" || activeRun.interruptRequested
                        ? Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore)
                        : Effect.sync(() => {
                            activeRun.typing.resume();
                          })
                      : activeRun.questionOutcome._tag !== "none" || activeRun.interruptRequested
                        ? Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore)
                        : Effect.void,
                ),
              ),
            ),
          );
        }),
      );

    const applyQuestionSignals = (
      sessionId: string,
      signals: ReadonlyArray<QuestionWorkflowSignal>,
    ) =>
      Effect.forEach(
        signals,
        (item) =>
          getSessionContext(sessionId).pipe(
            Effect.flatMap((context) => {
              const activeRun = context?.activeRun ?? null;
              switch (item.type) {
                case "clear-run-interrupt":
                  return !activeRun
                    ? Effect.void
                    : Effect.sync(() => {
                        activeRun.interruptRequested = false;
                        activeRun.interruptSource = null;
                      });
                case "set-run-question-outcome":
                  return !activeRun
                    ? Effect.void
                    : Effect.sync(() => {
                        activeRun.questionOutcome = item.outcome;
                      });
              }
            }),
          ),
        { concurrency: "unbounded", discard: true },
      );

    const applyQuestionWorkflowSignals = (
      sessionId: string,
      signals: ReadonlyArray<QuestionWorkflowSignal>,
    ) =>
      applyQuestionSignals(sessionId, signals).pipe(
        Effect.andThen(reconcileQuestionTypingForSession(sessionId)),
      );

    const handleQuestionEvent = (
      event: {
        sessionId: string;
      } & QuestionWorkflowEvent,
    ) =>
      Effect.gen(function* () {
        const routed = yield* questions.handleEvent(event);
        if (!routed) {
          return;
        }
        yield* applyQuestionWorkflowSignals(routed.sessionId, routed.signals);
      });

    const routeQuestionInteraction = (interaction: Interaction) =>
      Effect.gen(function* () {
        const routed = yield* questions.routeInteraction(interaction);
        if (!routed) {
          return;
        }
        yield* applyQuestionWorkflowSignals(routed.sessionId, routed.signals);
      });

    const serviceLayer = Layer.mergeAll(
      Layer.succeed(Logger, logger),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(OpencodeService, opencode),
    );
    const idleCompaction = yield* makeIdleCompactionWorkflow().pipe(Effect.provide(serviceLayer));
    idleCompactionWorkflow = idleCompaction;

    const eventHandler = createEventHandler({
      getSessionContext,
      handleQuestionEvent,
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

    const drainQueuedRunRequestsForShutdown = (session: ChannelSession) =>
      Queue.clear(session.queue).pipe(Effect.asVoid);

    const worker = (session: ChannelSession): Effect.Effect<never> =>
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

    const getUsableSession = (message: Message, reason: string) =>
      createOrGetSession(message).pipe(
        Effect.flatMap((session) => ensureSessionHealth(session, message, reason)),
      );

    const startShutdown = (): Effect.Effect<boolean> =>
      Ref.modify(shutdownStartedRef, (started): readonly [boolean, boolean] =>
        started ? [false, true] : [true, true],
      );

    const shutdown = createSessionShutdown({
      startShutdown,
      getState: () => Ref.get(stateRef),
      questionRuntime: questions,
      idleCompactionWorkflow: idleCompaction,
      opencode,
      logger,
      infoCards,
      drainQueuedRunRequestsForShutdown,
      interruptSessionWorkers: () => FiberSet.clear(fiberSet),
      shutdownSessions,
      formatError,
    });

    const sessionRuntime = makeSessionRuntime({
      getLoaded: (channelId) =>
        getSession(channelId).pipe(Effect.map((session) => session ?? null)),
      getOrRestore: getOrRestoreSession,
      getActiveRunBySessionId,
      queueMessageRunRequest: (message, request, reason) =>
        Effect.gen(function* () {
          const session = yield* getUsableSession(message, reason);
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
        routeQuestionInteraction(interaction).pipe(Effect.asVoid),
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
      interruptSession: (session) => opencode.interruptSession(session.opencode),
      setRunInterruptRequested: (activeRun, requested, source = requested ? "user" : null) =>
        Effect.sync(() => {
          activeRun.interruptRequested = requested;
          activeRun.interruptSource = requested ? source : null;
        }),
      isSessionBusy,
      hasPendingQuestions,
      hasIdleCompaction: (sessionId) => idleCompaction.hasActive(sessionId),
      startCompaction: (channelId, channel) =>
        getOrRestoreSession(channelId).pipe(
          Effect.flatMap((session) =>
            !session
              ? Effect.succeed({
                  type: "rejected",
                  message: "No OpenCode session exists in this channel yet.",
                } satisfies IdleCompactionWorkflowStartResult)
              : Effect.sync(() => {
                  session.progressChannel = channel;
                }).pipe(Effect.andThen(idleCompaction.start({ session, channel }))),
          ),
        ),
      requestCompactionInterrupt: (channelId) =>
        getOrRestoreSession(channelId).pipe(
          Effect.flatMap((session) =>
            !session
              ? Effect.succeed({
                  type: "failed",
                  message: "No active OpenCode run or compaction is running in this channel.",
                } satisfies IdleCompactionWorkflowInterruptResult)
              : idleCompaction.requestInterrupt({ session }),
          ),
        ),
      shutdown,
    });

    const sessionChannelBridge: SessionChannelBridgeShape = {
      readLoadedChannelActivity: sessionRuntime.readLoadedChannelActivity,
      readRestoredChannelActivity: sessionRuntime.readRestoredChannelActivity,
      queueMessageRunRequest: sessionRuntime.queueMessageRunRequest,
      routeQuestionInteraction: sessionRuntime.routeQuestionInteraction,
      invalidate: sessionRuntime.invalidate,
      updateLoadedChannelSettings: sessionRuntime.updateLoadedChannelSettings,
      requestRunInterrupt: sessionRuntime.requestRunInterrupt,
      startCompaction: sessionRuntime.startCompaction,
      requestCompactionInterrupt: sessionRuntime.requestCompactionInterrupt,
      shutdown: sessionRuntime.shutdown,
    };

    const sessionRunAccess: SessionRunAccessShape = {
      getActiveRunBySessionId: sessionRuntime.getActiveRunBySessionId,
    };

    return Layer.mergeAll(
      Layer.succeed(SessionRuntime, sessionRuntime),
      Layer.succeed(SessionChannelBridge, sessionChannelBridge),
      Layer.succeed(SessionRunAccess, sessionRunAccess),
    );
  }),
);
