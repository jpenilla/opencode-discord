import type { Message } from "discord.js";
import { Effect, Queue } from "effect";

import { buildSessionSystemAppend } from "@/discord/system-context.ts";
import type { OpencodeServiceShape, SessionHandle } from "@/opencode/service.ts";
import {
  type LoadedSessionHandle,
  type LoadedSessionHandleSupport,
  makeLoadedSessionHandle,
} from "@/sessions/loaded/handle.ts";
import type { LoadedSessionDirectory } from "@/sessions/loaded/directory.ts";
import type { SessionStoreShape } from "@/sessions/store.ts";
import { buildSessionCreateSpec, type ChannelSession, type RunRequest } from "@/sessions/types.ts";
import type { ChannelSettings } from "@/state/channel-settings.ts";
import { sessionPathsFromRoot } from "@/state/paths.ts";
import type { PersistedChannelSession } from "@/state/persistence.ts";
import type { LoggerShape } from "@/util/logging.ts";

export type CreateLoadedSessionInput = {
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
};

const toPersistedSession = (session: ChannelSession): PersistedChannelSession => ({
  channelId: session.channelId,
  opencodeSessionId: session.opencode.sessionId,
  rootDir: session.rootDir,
  systemPromptAppend: session.systemPromptAppend,
  createdAt: session.createdAt,
  lastActivityAt: session.lastActivityAt,
});

export const makeLoadedSessionFactory = (input: {
  loadedSessions: LoadedSessionDirectory;
  sessionStore: SessionStoreShape;
  opencode: OpencodeServiceShape;
  logger: LoggerShape;
  support: LoadedSessionHandleSupport;
  sessionInstructions: string;
  triggerPhrase: string;
}) => {
  const activateSession = (
    handle: LoadedSessionHandle,
    options?: {
      removePersistedOnFailure?: boolean;
    },
  ) =>
    handle.readSession().pipe(
      Effect.flatMap((session) =>
        Effect.gen(function* () {
          yield* input.sessionStore.savePersistedSession(toPersistedSession(session));
          yield* input.loadedSessions.updateSession(handle);
          yield* handle.startWorker();
          return session;
        }).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              yield* input.loadedSessions.deleteSession(handle);
              yield* handle.closeResources();
              if (options?.removePersistedOnFailure) {
                yield* input.sessionStore
                  .deletePersistedSession(session.channelId)
                  .pipe(Effect.ignore);
              }
            }).pipe(Effect.ignore),
          ),
        ),
      ),
    );

  const buildSessionHandle = (handleInput: {
    channelId: string;
    opencode: SessionHandle;
    rootDir: string;
    workdir: string;
    systemPromptAppend?: string;
    channelSettings: ChannelSettings;
    createdAt: number;
    lastActivityAt: number;
  }) =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<RunRequest>();
      let session!: ChannelSession;
      const compactionWorkflow = yield* input.support.createCompactionWorkflow(() => session);
      session = {
        channelId: handleInput.channelId,
        opencode: handleInput.opencode,
        systemPromptAppend: handleInput.systemPromptAppend,
        rootDir: handleInput.rootDir,
        workdir: handleInput.workdir,
        createdAt: handleInput.createdAt,
        lastActivityAt: handleInput.lastActivityAt,
        channelSettings: handleInput.channelSettings,
        progressChannel: null,
        progressMentionContext: null,
        emittedCompactionSummaryMessageIds: new Set<string>(),
        compactionWorkflow,
        queue,
        activeRun: null,
      } satisfies ChannelSession;
      return makeLoadedSessionHandle(session, input.support);
    });

  const createSessionAt = (sessionInput: CreateLoadedSessionInput) =>
    Effect.gen(function* () {
      const createSpec = buildSessionCreateSpec(sessionInput);
      const opencodeSession = yield* input.opencode.createSession(
        createSpec.workdir,
        createSpec.title,
        createSpec.systemPromptAppend,
      );
      const handle = yield* buildSessionHandle({
        channelId: sessionInput.channelId,
        opencode: opencodeSession,
        rootDir: sessionInput.rootDir,
        workdir: sessionInput.workdir,
        systemPromptAppend: sessionInput.systemPromptAppend,
        channelSettings: sessionInput.channelSettings,
        createdAt: sessionInput.createdAt,
        lastActivityAt: sessionInput.lastActivityAt,
      });

      const session = yield* activateSession(handle, {
        removePersistedOnFailure: sessionInput.removePersistedOnActivationFailure,
      });

      yield* input.logger.info("created channel session", {
        channelId: sessionInput.channelId,
        sessionId: opencodeSession.sessionId,
        backend: opencodeSession.backend,
        workdir: sessionInput.workdir,
        triggerPhrase: input.triggerPhrase,
        reason: sessionInput.logReason,
      });

      return {
        handle,
        session,
      } as const;
    }).pipe(
      Effect.onError(() =>
        sessionInput.deleteNewRootOnFailure
          ? input.sessionStore.deleteSessionRoot(sessionInput.rootDir).pipe(Effect.ignore)
          : Effect.void,
      ),
    );

  const createSession = (message: Message) =>
    Effect.gen(function* () {
      const { rootDir, workdir } = yield* input.sessionStore.createSessionPaths(message.channelId);
      return yield* Effect.gen(function* () {
        const now = Date.now();
        const { handle } = yield* createSessionAt({
          channelId: message.channelId,
          rootDir,
          workdir,
          systemPromptAppend: buildSessionSystemAppend({
            message,
            additionalInstructions: input.sessionInstructions,
          }),
          channelSettings: yield* input.sessionStore.loadChannelSettings(message.channelId),
          createdAt: now,
          lastActivityAt: now,
          removePersistedOnActivationFailure: true,
          deleteNewRootOnFailure: false,
        });
        return handle;
      }).pipe(
        Effect.onError(() => input.sessionStore.deleteSessionRoot(rootDir).pipe(Effect.ignore)),
      );
    });

  const attachPersistedSession = (
    channelId: string,
    persisted: PersistedChannelSession,
    lastActivityAt = Date.now(),
  ) =>
    Effect.gen(function* () {
      const { workdir } = sessionPathsFromRoot(persisted.rootDir);
      const channelSettings = yield* input.sessionStore.loadChannelSettings(channelId);

      const opencodeSession = yield* input.opencode.attachSession(
        workdir,
        persisted.opencodeSessionId,
        persisted.systemPromptAppend,
      );
      const handle = yield* buildSessionHandle({
        channelId,
        opencode: opencodeSession,
        rootDir: persisted.rootDir,
        workdir,
        systemPromptAppend: persisted.systemPromptAppend,
        channelSettings,
        createdAt: persisted.createdAt,
        lastActivityAt,
      });
      yield* activateSession(handle);
      yield* input.logger.info("attached channel session", {
        channelId,
        sessionId: opencodeSession.sessionId,
        backend: opencodeSession.backend,
        workdir,
      });
      return handle;
    });

  return {
    activateSession,
    createSessionAt,
    createSession,
    attachPersistedSession,
  } as const;
};
