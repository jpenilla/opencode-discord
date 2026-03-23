import { Effect, FileSystem, Layer, ServiceMap } from "effect";

import { AppConfig } from "@/config.ts";
import {
  defaultChannelSettings,
  resolveChannelSettings,
  type ChannelSettings,
} from "@/state/channel-settings.ts";
import { resolveStatePaths, sessionPathsForChannel, type SessionPaths } from "@/state/paths.ts";
import { StatePersistence, type PersistedChannelSession } from "@/state/persistence.ts";

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

export const SessionStoreLayer = Layer.effect(
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
