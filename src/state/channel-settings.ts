import type { AppConfigShape } from "@/config.ts";

export type PersistedChannelSettings = {
  channelId: string;
  showThinking?: boolean;
  showCompactionSummaries?: boolean;
};

export type ChannelSettings = {
  showThinking: boolean;
  showCompactionSummaries: boolean;
};

export const defaultChannelSettings = (
  config: Pick<AppConfigShape, "showThinkingByDefault" | "showCompactionSummariesByDefault">,
): ChannelSettings => ({
  showThinking: config.showThinkingByDefault,
  showCompactionSummaries: config.showCompactionSummariesByDefault,
});

export const resolveChannelSettings = (
  defaults: ChannelSettings,
  persisted?: Pick<PersistedChannelSettings, "showThinking" | "showCompactionSummaries"> | null,
): ChannelSettings => ({
  showThinking: persisted?.showThinking ?? defaults.showThinking,
  showCompactionSummaries: persisted?.showCompactionSummaries ?? defaults.showCompactionSummaries,
});
