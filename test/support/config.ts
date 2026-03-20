import { Redacted } from "effect";

import type { AppConfigShape } from "@/config.ts";

export const makeTestConfig = (overrides: Partial<AppConfigShape> = {}): AppConfigShape => ({
  discordToken: Redacted.make("discord-token"),
  triggerPhrase: "hey opencode",
  ignoreOtherBotTriggers: false,
  sessionInstructions: "",
  stateDir: "/tmp/opencode-discord-test-state",
  defaultProviderId: undefined,
  defaultModelId: undefined,
  showThinkingByDefault: true,
  showCompactionSummariesByDefault: true,
  sessionIdleTimeoutMs: 30 * 60 * 1_000,
  toolBridgeSocketPath: "/tmp/opencode-discord-bridge.sock",
  toolBridgeToken: Redacted.make("bridge-token"),
  sandboxBackend: "unsafe-dev",
  opencodeBin: "opencode",
  bwrapBin: "bwrap",
  sandboxReadOnlyPaths: [],
  sandboxEnvPassthrough: [],
  ...overrides,
});
