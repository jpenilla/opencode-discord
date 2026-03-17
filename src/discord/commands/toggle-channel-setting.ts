import { Effect } from "effect";

import { GUILD_TEXT_COMMAND_ONLY_MESSAGE } from "@/sessions/command-lifecycle.ts";
import {
  resolveChannelSettings,
  type ChannelSettings,
  type PersistedChannelSettings,
} from "@/state/channel-settings.ts";

import { defineLoadedSessionCommand, type GuildCommand } from "./definition.ts";
import { replyToCommandInteraction } from "./interaction.ts";

type ToggleableChannelSetting = keyof Pick<
  ChannelSettings,
  "showThinking" | "showCompactionSummaries"
>;

const executeToggleChannelSetting =
  (setting: ToggleableChannelSetting, label: string): GuildCommand["execute"] =>
  (context) =>
    Effect.gen(function* () {
      if (!context.inGuildTextChannel) {
        yield* replyToCommandInteraction(context.interaction, GUILD_TEXT_COMMAND_ONLY_MESSAGE);
        return true;
      }

      const persistedSettings = yield* context.deps.getChannelSettings(
        context.interaction.channelId,
      );
      const currentSettings = resolveChannelSettings(
        context.deps.channelSettingsDefaults,
        persistedSettings,
      );
      const nextSettings: PersistedChannelSettings = {
        channelId: context.interaction.channelId,
        showThinking: persistedSettings?.showThinking,
        showCompactionSummaries: persistedSettings?.showCompactionSummaries,
      };
      nextSettings[setting] = !currentSettings[setting];

      yield* context.deps.upsertChannelSettings(nextSettings);

      const resolvedSettings = resolveChannelSettings(
        context.deps.channelSettingsDefaults,
        nextSettings,
      );
      if (context.session) {
        context.session.channelSettings = resolvedSettings;
      }

      yield* replyToCommandInteraction(
        context.interaction,
        `${label} are now ${resolvedSettings[setting] ? "enabled" : "disabled"} in this channel.`,
      );
      return true;
    });

const defineChannelSettingToggleCommand = <
  const TName extends string,
  const TDescription extends string,
>(input: {
  name: TName;
  description: TDescription;
  setting: ToggleableChannelSetting;
  label: string;
}) =>
  defineLoadedSessionCommand({
    name: input.name,
    description: input.description,
    execute: executeToggleChannelSetting(input.setting, input.label),
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
