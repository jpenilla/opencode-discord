import { mkdir } from "node:fs/promises";

import { Database } from "bun:sqlite";
import { Effect, Layer, ServiceMap } from "effect";

import { AppConfig } from "@/config.ts";
import type { PersistedChannelSettings } from "@/state/channel-settings.ts";
import { resolveStatePaths } from "@/state/paths.ts";

export type PersistedChannelSession = {
  channelId: string;
  opencodeSessionId: string;
  rootDir: string;
  systemPromptAppend?: string;
  createdAt: number;
  lastActivityAt: number;
};

export type SessionStoreShape = {
  getSession: (channelId: string) => Effect.Effect<PersistedChannelSession | null>;
  upsertSession: (session: PersistedChannelSession) => Effect.Effect<void>;
  touchSession: (channelId: string, lastActivityAt: number) => Effect.Effect<void>;
  deleteSession: (channelId: string) => Effect.Effect<void>;
  getChannelSettings: (channelId: string) => Effect.Effect<PersistedChannelSettings | null>;
  upsertChannelSettings: (settings: PersistedChannelSettings) => Effect.Effect<void>;
};

export class SessionStore extends ServiceMap.Service<SessionStore, SessionStoreShape>()("SessionStore") {}

type PersistedChannelSessionRow = {
  channel_id: string;
  opencode_session_id: string;
  root_dir: string;
  system_prompt_append: string | null;
  created_at: number;
  last_activity_at: number;
};

type PersistedChannelSettingsRow = {
  channel_id: string;
  show_thinking: 0 | 1 | null;
  show_compaction_summaries: 0 | 1 | null;
};

const bootstrapSchema = (db: Database) => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS channel_sessions (
      channel_id TEXT PRIMARY KEY NOT NULL,
      opencode_session_id TEXT NOT NULL,
      root_dir TEXT NOT NULL,
      system_prompt_append TEXT,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_sessions_last_activity_at
      ON channel_sessions (last_activity_at);

    CREATE TABLE IF NOT EXISTS channel_settings (
      channel_id TEXT PRIMARY KEY NOT NULL,
      show_thinking INTEGER,
      show_compaction_summaries INTEGER
    );
  `);
};

const fromRow = (row: PersistedChannelSessionRow): PersistedChannelSession => ({
  channelId: row.channel_id,
  opencodeSessionId: row.opencode_session_id,
  rootDir: row.root_dir,
  systemPromptAppend: row.system_prompt_append ?? undefined,
  createdAt: row.created_at,
  lastActivityAt: row.last_activity_at,
});

const fromChannelSettingsRow = (row: PersistedChannelSettingsRow): PersistedChannelSettings => ({
  channelId: row.channel_id,
  showThinking: row.show_thinking === null ? undefined : row.show_thinking === 1,
  showCompactionSummaries:
    row.show_compaction_summaries === null ? undefined : row.show_compaction_summaries === 1,
});

export const SessionStoreLayer = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const statePaths = resolveStatePaths(config.stateDir);

    yield* Effect.promise(() => mkdir(statePaths.rootDir, { recursive: true }));
    yield* Effect.promise(() => mkdir(statePaths.sessionsRootDir, { recursive: true }));

    const db = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const database = new Database(statePaths.dbPath, { create: true, strict: true });
        bootstrapSchema(database);
        return database;
      }),
      (database) =>
        Effect.sync(() => {
          database.close(false);
        }).pipe(Effect.ignore),
    );

    const getSessionStatement = db.query<PersistedChannelSessionRow, [string]>(`
      SELECT
        channel_id,
        opencode_session_id,
        root_dir,
        system_prompt_append,
        created_at,
        last_activity_at
      FROM channel_sessions
      WHERE channel_id = ?1
    `);

    const upsertSessionStatement = db.query(`
      INSERT INTO channel_sessions (
        channel_id,
        opencode_session_id,
        root_dir,
        system_prompt_append,
        created_at,
        last_activity_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(channel_id) DO UPDATE SET
        opencode_session_id = excluded.opencode_session_id,
        root_dir = excluded.root_dir,
        system_prompt_append = excluded.system_prompt_append,
        created_at = excluded.created_at,
        last_activity_at = excluded.last_activity_at
    `);

    const touchSessionStatement = db.query(`
      UPDATE channel_sessions
      SET last_activity_at = ?2
      WHERE channel_id = ?1
    `);

    const deleteSessionStatement = db.query(`
      DELETE FROM channel_sessions
      WHERE channel_id = ?1
    `);

    const getChannelSettingsStatement = db.query<PersistedChannelSettingsRow, [string]>(`
      SELECT
        channel_id,
        show_thinking,
        show_compaction_summaries
      FROM channel_settings
      WHERE channel_id = ?1
    `);

    const upsertChannelSettingsStatement = db.query(`
      INSERT INTO channel_settings (
        channel_id,
        show_thinking,
        show_compaction_summaries
      ) VALUES (?1, ?2, ?3)
      ON CONFLICT(channel_id) DO UPDATE SET
        show_thinking = excluded.show_thinking,
        show_compaction_summaries = excluded.show_compaction_summaries
    `);

    return {
      getSession: (channelId) =>
        Effect.sync(() => {
          const row = getSessionStatement.get(channelId);
          return row ? fromRow(row) : null;
        }),
      upsertSession: (session) =>
        Effect.sync(() => {
          upsertSessionStatement.run(
            session.channelId,
            session.opencodeSessionId,
            session.rootDir,
            session.systemPromptAppend ?? null,
            session.createdAt,
            session.lastActivityAt,
          );
        }),
      touchSession: (channelId, lastActivityAt) =>
        Effect.sync(() => {
          touchSessionStatement.run(channelId, lastActivityAt);
        }),
      deleteSession: (channelId) =>
        Effect.sync(() => {
          deleteSessionStatement.run(channelId);
        }),
      getChannelSettings: (channelId) =>
        Effect.sync(() => {
          const row = getChannelSettingsStatement.get(channelId);
          return row ? fromChannelSettingsRow(row) : null;
        }),
      upsertChannelSettings: (settings) =>
        Effect.sync(() => {
          upsertChannelSettingsStatement.run(
            settings.channelId,
            settings.showThinking === undefined ? null : Number(settings.showThinking),
            settings.showCompactionSummaries === undefined
              ? null
              : Number(settings.showCompactionSummaries),
          );
        }),
    } satisfies SessionStoreShape;
  }),
);
