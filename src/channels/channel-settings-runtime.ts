import { Effect, ServiceMap } from "effect";

import type { ChannelSettings, PersistedChannelSettings } from "@/state/channel-settings.ts";
import { resolveChannelSettings } from "@/state/channel-settings.ts";

export type ToggleableChannelSetting = keyof Pick<
  ChannelSettings,
  "showThinking" | "showCompactionSummaries"
>;

export type ChannelSettingsRuntimeShape = {
  toggle: (
    channelId: string,
    setting: ToggleableChannelSetting,
  ) => Effect.Effect<ChannelSettings, unknown>;
};

export class ChannelSettingsRuntime extends ServiceMap.Service<
  ChannelSettingsRuntime,
  ChannelSettingsRuntimeShape
>()("ChannelSettingsRuntime") {}

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

export const makeChannelSettingsRuntime = (deps: {
  defaults: ChannelSettings;
  getPersistedChannelSettings: (
    channelId: string,
  ) => Effect.Effect<PersistedChannelSettings | null, unknown>;
  upsertPersistedChannelSettings: (
    settings: PersistedChannelSettings,
  ) => Effect.Effect<void, unknown>;
  updateLoadedChannelSettings: (
    channelId: string,
    settings: ChannelSettings,
  ) => Effect.Effect<void, unknown>;
}): ChannelSettingsRuntimeShape => ({
  toggle: (channelId, setting) =>
    deps.getPersistedChannelSettings(channelId).pipe(
      Effect.flatMap((persisted) => {
        const { next, resolved } = resolveToggledSettings(deps.defaults, persisted, setting);
        next.channelId = channelId;
        return deps
          .upsertPersistedChannelSettings(next)
          .pipe(
            Effect.andThen(deps.updateLoadedChannelSettings(channelId, resolved)),
            Effect.as(resolved),
          );
      }),
    ),
});
