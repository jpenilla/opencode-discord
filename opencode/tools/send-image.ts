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
  description: "Send an image from the current session workdir to Discord.",
  args: {
    path: tool.schema.string().describe("Path to the image to upload."),
    caption: tool.schema.string().optional().describe("Optional Discord caption."),
  },
  async execute(args, context) {
    return send("/tool/send-image", {
      sessionID: context.sessionID,
      path: args.path,
      caption: args.caption,
    })
  },
})
