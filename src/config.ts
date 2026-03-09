import { Context, Effect, Layer } from "effect"

export type AppConfigShape = {
  discordToken: string
  triggerPhrase: string
  sessionInstructions: string
  stateDir: string
  sessionIdleTimeoutMs: number
  toolBridgeSocketPath: string
  toolBridgeToken: string
  sandboxBackend: "auto" | "unsafe-dev" | "bwrap"
  opencodeBin: string
  bwrapBin: string
  sandboxReadOnlyPaths: ReadonlyArray<string>
  sandboxEnvPassthrough: ReadonlyArray<string>
}

export class AppConfig extends Context.Tag("AppConfig")<AppConfig, AppConfigShape>() {}

const parseSandboxBackend = (value: string | undefined): AppConfigShape["sandboxBackend"] => {
  switch (value?.trim().toLowerCase() ?? "auto") {
    case "auto":
      return "auto"
    case "unsafe-dev":
      return "unsafe-dev"
    case "bwrap":
      return "bwrap"
    default:
      throw new Error(`Invalid SANDBOX_BACKEND: ${value}`)
  }
}

const parsePathList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

const parsePositiveInteger = (value: string | undefined, fallback: number, name: string) => {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`)
  }
  return parsed
}

export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.sync(() => {
    const discordToken = Bun.env.DISCORD_TOKEN
    if (!discordToken) {
      throw new Error("Missing DISCORD_TOKEN")
    }
    const toolBridgeSocketPath = Bun.env.DISCORD_TOOL_BRIDGE_SOCKET
      ?? `/tmp/opencode-discord-${process.pid}-${crypto.randomUUID().slice(0, 8)}/bridge.sock`

    return {
      discordToken,
      triggerPhrase: Bun.env.TRIGGER_PHRASE ?? "hey opencode",
      sessionInstructions: Bun.env.SESSION_INSTRUCTIONS ?? "",
      stateDir: Bun.env.STATE_DIR ?? "./storage",
      sessionIdleTimeoutMs: parsePositiveInteger(Bun.env.SESSION_IDLE_TIMEOUT_MS, 30 * 60 * 1_000, "SESSION_IDLE_TIMEOUT_MS"),
      toolBridgeSocketPath,
      toolBridgeToken: crypto.randomUUID(),
      sandboxBackend: parseSandboxBackend(Bun.env.SANDBOX_BACKEND),
      opencodeBin: Bun.env.OPENCODE_BIN ?? "opencode",
      bwrapBin: Bun.env.BWRAP_BIN ?? "bwrap",
      sandboxReadOnlyPaths: parsePathList(Bun.env.SANDBOX_READ_ONLY_PATHS),
      sandboxEnvPassthrough: parsePathList(Bun.env.SANDBOX_ENV_PASSTHROUGH),
    } satisfies AppConfigShape
  }),
)
