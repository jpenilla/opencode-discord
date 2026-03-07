import { Context, Effect, Layer } from "effect"

export type AppConfigShape = {
  discordToken: string
  triggerPhrase: string
  opencodeServerHost: string
  opencodeServerPort: number
  opencodeServerBaseUrl: string
  toolBridgeHost: string
  toolBridgePort: number
  toolBridgeToken: string
}

export class AppConfig extends Context.Tag("AppConfig")<AppConfig, AppConfigShape>() {}

const parsePort = (name: string, value: string | undefined, fallback: number) => {
  const raw = value ?? String(fallback)
  const port = Number.parseInt(raw, 10)
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${name}: ${raw}`)
  }
  return port
}

export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.sync(() => {
    const discordToken = Bun.env.DISCORD_TOKEN
    if (!discordToken) {
      throw new Error("Missing DISCORD_TOKEN")
    }

    const opencodeServerHost = Bun.env.OPENCODE_SERVER_HOST ?? "127.0.0.1"
    const opencodeServerPort = parsePort("OPENCODE_SERVER_PORT", Bun.env.OPENCODE_SERVER_PORT, 4096)
    const opencodeServerBaseUrl =
      Bun.env.OPENCODE_SERVER_BASE_URL ?? `http://${opencodeServerHost}:${opencodeServerPort}`
    const toolBridgeHost = Bun.env.DISCORD_TOOL_BRIDGE_HOST ?? "127.0.0.1"
    const toolBridgePort = parsePort("DISCORD_TOOL_BRIDGE_PORT", Bun.env.DISCORD_TOOL_BRIDGE_PORT, 8787)

    return {
      discordToken,
      triggerPhrase: Bun.env.TRIGGER_PHRASE ?? "hey opencode",
      opencodeServerHost,
      opencodeServerPort,
      opencodeServerBaseUrl,
      toolBridgeHost,
      toolBridgePort,
      toolBridgeToken: Bun.env.DISCORD_TOOL_BRIDGE_TOKEN ?? crypto.randomUUID(),
    } satisfies AppConfigShape
  }),
)
