import { Effect } from "effect";

import { GUILD_TEXT_COMMAND_ONLY_MESSAGE } from "@/channels/command-policy.ts";
import { AppConfig } from "@/config.ts";
import { CommandContext } from "@/discord/command-context.ts";
import type { ChannelSettings } from "@/state/channel-settings.ts";
import {
  defaultChannelSettings,
  resolveChannelSettings,
  type PersistedChannelSettings,
} from "@/state/channel-settings.ts";
import { SessionChannelBridge } from "@/sessions/session-runtime.ts";
import { ChannelSettingsPersistence } from "@/state/persistence.ts";

import { defineGuildCommand } from "./definition.ts";

type ToggleableChannelSetting = keyof Pick<
  ChannelSettings,
  "showThinking" | "showCompactionSummaries"
>;

const resolveToggledSettings = (
  defaults: ChannelSettings,
  persisted: PersistedChannelSettings | null,
  setting: ToggleableChannelSetting,
) => {
  const current = resolveChannelSettings(defaults, persisted);
  const next: PersistedChannelSettings = {
    channelId: persisted?.channelId ?? "",
    showThinking: persisted?.showThinking,
    showCompactionSummaries: persisted?.showCompactionSummaries,
  };
  next[setting] = !current[setting];

  return {
    next,
    resolved: resolveChannelSettings(defaults, next),
  };
};

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
      const config = yield* AppConfig;
      const channelSettingsPersistence = yield* ChannelSettingsPersistence;
      const sessionBridge = yield* SessionChannelBridge;

      if (!context.inGuildTextChannel) {
        yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
        return;
      }

      const persisted = yield* channelSettingsPersistence.getChannelSettings(context.channelId);
      const { next, resolved } = resolveToggledSettings(
        defaultChannelSettings(config),
        persisted,
        input.setting,
      );
      next.channelId = context.channelId;
      yield* channelSettingsPersistence.upsertChannelSettings(next);
      yield* sessionBridge.updateLoadedChannelSettings(context.channelId, resolved);

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
