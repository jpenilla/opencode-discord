import { Effect } from "effect";

import { AppConfig } from "@/config.ts";
import { CommandContext } from "@/discord/commands/command-context.ts";
import type { ChannelSettings } from "@/state/channel-settings.ts";
import {
  defaultChannelSettings,
  resolveChannelSettings,
  type PersistedChannelSettings,
} from "@/state/channel-settings.ts";
import { GUILD_TEXT_COMMAND_ONLY_MESSAGE } from "@/sessions/command-lifecycle.ts";
import { SessionControl } from "@/sessions/session-control.ts";
import { SessionStore } from "@/state/store.ts";

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
      const sessionControl = yield* SessionControl;
      const sessionStore = yield* SessionStore;

      if (!context.inGuildTextChannel) {
        yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
        return;
      }

      const persisted = yield* sessionStore.getChannelSettings(context.channelId);
      const { next, resolved } = resolveToggledSettings(
        defaultChannelSettings(config),
        persisted,
        input.setting,
      );
      next.channelId = context.channelId;
      yield* sessionStore.upsertChannelSettings(next);

      const session = yield* sessionControl.getLoaded(context.channelId);
      if (session) {
        yield* sessionControl.setChannelSettings(session, resolved);
      }

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
