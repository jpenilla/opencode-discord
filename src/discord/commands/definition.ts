import { Effect } from "effect";

import { ChannelSettingsRuntime } from "@/channels/channel-settings-runtime.ts";
import { CommandContext } from "@/discord/commands/command-context.ts";
import { InfoCards } from "@/discord/info-cards.ts";
import { SessionChannelBridge } from "@/sessions/session-runtime.ts";
import { Logger } from "@/util/logging.ts";

export type GuildCommandDependencies =
  | ChannelSettingsRuntime
  | InfoCards
  | SessionChannelBridge
  | Logger;

export type GuildCommand = {
  name: string;
  description: string;
  execute: Effect.Effect<void, unknown, CommandContext | GuildCommandDependencies>;
};

type GuildCommandDefinitionInput<TName extends string, TDescription extends string> = {
  name: TName;
  description: TDescription;
  execute: GuildCommand["execute"];
};

export const defineGuildCommand = <const TName extends string, const TDescription extends string>(
  input: GuildCommandDefinitionInput<TName, TDescription>,
) =>
  ({
    name: input.name,
    description: input.description,
    execute: input.execute,
  }) satisfies GuildCommand;
