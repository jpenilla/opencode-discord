import { compactCommand } from "@/channels/commands/compact.ts";
import type { GuildCommand } from "@/channels/commands/definition.ts";
import { interruptCommand } from "@/channels/commands/interrupt.ts";
import { newSessionCommand } from "@/channels/commands/new-session.ts";
import {
  toggleCompactionSummariesCommand,
  toggleThinkingCommand,
} from "@/channels/commands/toggle-channel-setting.ts";

export type { GuildCommand } from "@/channels/commands/definition.ts";

export const GUILD_COMMANDS = [
  compactCommand,
  interruptCommand,
  newSessionCommand,
  toggleThinkingCommand,
  toggleCompactionSummariesCommand,
] as const;

export type GuildCommandName = (typeof GUILD_COMMANDS)[number]["name"];

const commandsByName = new Map<GuildCommandName, (typeof GUILD_COMMANDS)[number]>(
  GUILD_COMMANDS.map((command) => [command.name, command]),
);

export const getGuildCommand = (name: string): GuildCommand | null =>
  commandsByName.get(name as GuildCommandName) ?? null;
