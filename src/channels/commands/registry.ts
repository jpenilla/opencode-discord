import { compactCommand } from "@/channels/commands/compact.ts";
import { interruptCommand } from "@/channels/commands/interrupt.ts";
import { newSessionCommand } from "@/channels/commands/new-session.ts";
import {
  toggleCompactionSummariesCommand,
  toggleThinkingCommand,
} from "@/channels/commands/toggle-channel-setting.ts";
import { Effect, FileSystem, Path } from "effect";

import { AppConfig } from "@/config.ts";
import { CommandContext } from "@/discord/command-context.ts";
import { InfoCards } from "@/discord/info-card.ts";
import { SessionRuntime } from "@/sessions/runtime.ts";
import { StatePersistence } from "@/state/persistence.ts";
import { Logger } from "@/util/logging.ts";

export type GuildCommandDependencies =
  | AppConfig
  | StatePersistence
  | InfoCards
  | SessionRuntime
  | Logger;

export type GuildCommand = {
  name: string;
  description: string;
  execute: Effect.Effect<
    void,
    unknown,
    CommandContext | GuildCommandDependencies | FileSystem.FileSystem | Path.Path
  >;
};

export const GUILD_COMMANDS = [
  compactCommand,
  interruptCommand,
  newSessionCommand,
  toggleThinkingCommand,
  toggleCompactionSummariesCommand,
] as const satisfies ReadonlyArray<GuildCommand>;

export type GuildCommandName = (typeof GUILD_COMMANDS)[number]["name"];

const commandsByName = new Map<GuildCommandName, (typeof GUILD_COMMANDS)[number]>(
  GUILD_COMMANDS.map((command) => [command.name, command]),
);

export const getGuildCommand = (name: string): GuildCommand | null =>
  commandsByName.get(name as GuildCommandName) ?? null;
