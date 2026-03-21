import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";

import type { AppConfigShape } from "@/config.ts";

export const makeTestConfig = (overrides: Partial<AppConfigShape> = {}): AppConfigShape => {
  const id = randomUUID();

  return {
    discordToken: Redacted.make("discord-token"),
    triggerPhrase: "hey opencode",
    ignoreOtherBotTriggers: false,
    sessionInstructions: "",
    stateDir: join(tmpdir(), `opencode-discord-test-state-${id}`),
    defaultProviderId: undefined,
    defaultModelId: undefined,
    showThinkingByDefault: true,
    showCompactionSummariesByDefault: true,
    sessionIdleTimeoutMs: 30 * 60 * 1_000,
    toolBridgeSocketPath: join(tmpdir(), `opencode-discord-bridge-${id}.sock`),
    toolBridgeToken: Redacted.make("bridge-token"),
    sandboxBackend: "bwrap",
    opencodeBin: "opencode",
    bwrapBin: "bwrap",
    sandboxReadOnlyPaths: [],
    sandboxEnvPassthrough: [],
    ...overrides,
  };
};
