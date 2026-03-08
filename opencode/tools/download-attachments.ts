import { tool } from "@opencode-ai/plugin"

const bridgeUrl = process.env.OPENCODE_DISCORD_BRIDGE_URL
const bridgeToken = process.env.OPENCODE_DISCORD_BRIDGE_TOKEN

const send = async (path: string, body: Record<string, unknown>) => {
  if (!bridgeUrl || !bridgeToken) {
    throw new Error("Missing OPENCODE_DISCORD_BRIDGE_URL or OPENCODE_DISCORD_BRIDGE_TOKEN")
  }

  const response = await fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-discord-token": bridgeToken,
    },
    body: JSON.stringify(body),
  })

  const data = (await response.json()) as { error?: string; message?: string }
  if (!response.ok) {
    throw new Error(data.error ?? `Bridge request failed with status ${response.status}`)
  }

  return data.message ?? "ok"
}

export default tool({
  description: "Download files attached to the Discord message that triggered this run into the session workdir.",
  args: {
    directory: tool.schema.string().optional().describe("Optional destination directory inside the current session workdir."),
  },
  async execute(args, context) {
    return send("/tool/download-attachments", {
      sessionID: context.sessionID,
      directory: args.directory,
    })
  },
})
