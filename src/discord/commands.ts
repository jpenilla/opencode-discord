import { SlashCommandBuilder, type Guild } from "discord.js";

import { compactCommand } from "./commands/compact.ts";
import { type GuildCommand } from "./commands/definition.ts";
import { interruptCommand } from "./commands/interrupt.ts";
import { newSessionCommand } from "./commands/new-session.ts";
import {
  toggleCompactionSummariesCommand,
  toggleThinkingCommand,
} from "./commands/toggle-channel-setting.ts";

export type {
  GuildCommand,
  GuildCommandExecutionContext,
  GuildCommandDeps,
} from "./commands/definition.ts";

export const GUILD_COMMANDS = [
  compactCommand,
  interruptCommand,
  newSessionCommand,
  toggleThinkingCommand,
  toggleCompactionSummariesCommand,
] as const;

export type GuildCommandName = (typeof GUILD_COMMANDS)[number]["name"];

const GUILD_COMMANDS_BY_NAME = new Map<GuildCommandName, (typeof GUILD_COMMANDS)[number]>(
  GUILD_COMMANDS.map((command) => [command.name, command]),
);

export const getGuildCommand = (name: string): GuildCommand | null =>
  GUILD_COMMANDS_BY_NAME.get(name as GuildCommandName) ?? null;

const buildSlashCommandPayload = (command: Pick<GuildCommand, "name" | "description">) =>
  new SlashCommandBuilder().setName(command.name).setDescription(command.description).toJSON();

const SLASH_COMMAND_PAYLOADS = GUILD_COMMANDS.map(buildSlashCommandPayload);

export const syncGuildCommands = async (guild: Guild) => {
  await guild.commands.set(SLASH_COMMAND_PAYLOADS);
};
