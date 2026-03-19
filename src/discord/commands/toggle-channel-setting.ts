import { Effect } from "effect";

import {
  ChannelSettingsRuntime,
  type ToggleableChannelSetting,
} from "@/channels/channel-settings-runtime.ts";
import { GUILD_TEXT_COMMAND_ONLY_MESSAGE } from "@/channels/command-policy.ts";
import { CommandContext } from "@/discord/commands/command-context.ts";

import { defineGuildCommand } from "./definition.ts";

const defineChannelSettingToggleCommand = <
  const TName extends string,
  const TDescription extends string,
>(input: {
  name: TName;
  description: TDescription;
  setting: ToggleableChannelSetting;
  label: string;
}) =>
  defineGuildCommand({
    name: input.name,
    description: input.description,
    execute: Effect.gen(function* () {
      const context = yield* CommandContext;
      const channelSettings = yield* ChannelSettingsRuntime;

      if (!context.inGuildTextChannel) {
        yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
        return;
      }

      const resolved = yield* channelSettings.toggle(context.channelId, input.setting);

      yield* context.complete(
        `${input.label} are now ${resolved[input.setting] ? "enabled" : "disabled"} in this channel.`,
      );
    }),
  });

export const toggleThinkingCommand = defineChannelSettingToggleCommand({
  name: "toggle-thinking",
  description: "Toggle thinking progress messages in this channel",
  setting: "showThinking",
  label: "Thinking messages",
});

export const toggleCompactionSummariesCommand = defineChannelSettingToggleCommand({
  name: "toggle-compaction-summaries",
  description: "Toggle compaction summaries in this channel",
  setting: "showCompactionSummaries",
  label: "Compaction summaries",
});
