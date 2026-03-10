import { SlashCommandBuilder, type Guild } from "discord.js";

export const GUILD_COMMAND_NAME = {
  compact: "compact",
  interrupt: "interrupt",
  toggleThinking: "toggle-thinking",
  toggleCompactionSummaries: "toggle-compaction-summaries",
} as const;

export type GuildCommandName = (typeof GUILD_COMMAND_NAME)[keyof typeof GUILD_COMMAND_NAME];

const GUILD_COMMAND_NAME_SET = new Set<string>(Object.values(GUILD_COMMAND_NAME));

export const isGuildCommandName = (value: string): value is GuildCommandName =>
  GUILD_COMMAND_NAME_SET.has(value);

export const isVisibilityToggleCommandName = (
  value: GuildCommandName,
): value is
  | typeof GUILD_COMMAND_NAME.toggleThinking
  | typeof GUILD_COMMAND_NAME.toggleCompactionSummaries =>
  value === GUILD_COMMAND_NAME.toggleThinking ||
  value === GUILD_COMMAND_NAME.toggleCompactionSummaries;

const GUILD_COMMANDS = [
  new SlashCommandBuilder()
    .setName(GUILD_COMMAND_NAME.compact)
    .setDescription("Compact the current OpenCode session in this channel"),
  new SlashCommandBuilder()
    .setName(GUILD_COMMAND_NAME.interrupt)
    .setDescription("Interrupt the active OpenCode run in this channel"),
  new SlashCommandBuilder()
    .setName(GUILD_COMMAND_NAME.toggleThinking)
    .setDescription("Toggle thinking progress messages in this channel"),
  new SlashCommandBuilder()
    .setName(GUILD_COMMAND_NAME.toggleCompactionSummaries)
    .setDescription("Toggle compaction summaries in this channel"),
].map((command) => command.toJSON());

export const syncGuildCommands = async (guild: Guild) => {
  await guild.commands.set(GUILD_COMMANDS);
};
