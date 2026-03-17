import type { ChatInputCommandInteraction, Message, SendableChannels } from "discord.js";
import { Effect } from "effect";

import type { ChannelSession } from "@/sessions/session.ts";
import type { ChannelSettings, PersistedChannelSettings } from "@/state/channel-settings.ts";
import type { LoggerShape } from "@/util/logging.ts";

export type GuildCommandDeps = {
  getSession: (channelId: string) => Effect.Effect<ChannelSession | null, unknown>;
  getLoadedSession: (channelId: string) => Effect.Effect<ChannelSession | null, unknown>;
  invalidateSession: (channelId: string, reason: string) => Effect.Effect<void, unknown>;
  getChannelSettings: (
    channelId: string,
  ) => Effect.Effect<PersistedChannelSettings | null, unknown>;
  upsertChannelSettings: (settings: PersistedChannelSettings) => Effect.Effect<void, unknown>;
  channelSettingsDefaults: ChannelSettings;
  hasIdleCompaction: (sessionId: string) => Effect.Effect<boolean, unknown>;
  hasPendingQuestions: (sessionId: string) => Effect.Effect<boolean, unknown>;
  getIdleCompactionCard: (sessionId: string) => Effect.Effect<Message | null, unknown>;
  beginIdleCompaction: (sessionId: string) => Effect.Effect<void, unknown>;
  setIdleCompactionCard: (sessionId: string, card: Message | null) => Effect.Effect<void, unknown>;
  setIdleCompactionInterruptRequested: (
    sessionId: string,
    interruptRequested: boolean,
  ) => Effect.Effect<void, unknown>;
  getIdleCompactionInterruptRequested: (sessionId: string) => Effect.Effect<boolean, unknown>;
  updateIdleCompactionCard: (
    sessionId: string,
    title: string,
    body: string,
  ) => Effect.Effect<void, unknown>;
  finalizeIdleCompactionCard: (
    sessionId: string,
    title: string,
    body: string,
  ) => Effect.Effect<void, unknown>;
  isSessionHealthy: (session: ChannelSession["opencode"]) => Effect.Effect<boolean, unknown>;
  compactSession: (session: ChannelSession["opencode"]) => Effect.Effect<void, unknown>;
  interruptSession: (session: ChannelSession["opencode"]) => Effect.Effect<void, unknown>;
  upsertInfoCard: (input: {
    channel: SendableChannels;
    existingCard: Message | null;
    title: string;
    body: string;
  }) => Promise<Message>;
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

export type GuildCommandExecutionContext = {
  deps: GuildCommandDeps;
  interaction: ChatInputCommandInteraction;
  inGuildTextChannel: boolean;
  session: ChannelSession | null;
};

type GuildCommandSessionResolver = (
  deps: Pick<GuildCommandDeps, "getSession" | "getLoadedSession">,
  interaction: ChatInputCommandInteraction,
  inGuildTextChannel: boolean,
) => Effect.Effect<ChannelSession | null, unknown>;

export type GuildCommand = {
  name: string;
  description: string;
  resolveSession: GuildCommandSessionResolver;
  execute: (context: GuildCommandExecutionContext) => Effect.Effect<boolean, unknown>;
};

type GuildCommandDefinitionInput<TName extends string, TDescription extends string> = {
  name: TName;
  description: TDescription;
  execute: GuildCommand["execute"];
};

const defineGuildCommand = <const T extends GuildCommand>(command: T) => command;

const resolveLoadedSession: GuildCommandSessionResolver = (deps, interaction, inGuildTextChannel) =>
  inGuildTextChannel ? deps.getLoadedSession(interaction.channelId) : Effect.succeed(null);

const resolveRestoredSession: GuildCommandSessionResolver = (
  deps,
  interaction,
  inGuildTextChannel,
) => (inGuildTextChannel ? deps.getSession(interaction.channelId) : Effect.succeed(null));

export const defineSessionCommand = <const TName extends string, const TDescription extends string>(
  input: GuildCommandDefinitionInput<TName, TDescription>,
) =>
  defineGuildCommand({
    name: input.name,
    description: input.description,
    resolveSession: resolveRestoredSession,
    execute: input.execute,
  });

export const defineLoadedSessionCommand = <
  const TName extends string,
  const TDescription extends string,
>(
  input: GuildCommandDefinitionInput<TName, TDescription>,
) =>
  defineGuildCommand({
    name: input.name,
    description: input.description,
    resolveSession: resolveLoadedSession,
    execute: input.execute,
  });
