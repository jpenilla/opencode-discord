import { request } from "node:http"

const bridgeSocketPath = process.env.OPENCODE_DISCORD_BRIDGE_SOCKET
const bridgeToken = process.env.OPENCODE_DISCORD_BRIDGE_TOKEN

const ensureBridgeConfig = () => {
  if (!bridgeSocketPath || !bridgeToken) {
    throw new Error("Missing OPENCODE_DISCORD_BRIDGE_SOCKET or OPENCODE_DISCORD_BRIDGE_TOKEN")
  }

  return {
    bridgeSocketPath,
    bridgeToken,
  }
}

export const sendBridgeRequest = async (path: string, body: Record<string, unknown>) => {
  const { bridgeSocketPath, bridgeToken } = ensureBridgeConfig()

  const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        socketPath: bridgeSocketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-discord-token": bridgeToken,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
        })
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        })
      },
    )

    req.on("error", reject)
    req.end(JSON.stringify(body))
  })

  const data = response.body.length > 0 ? JSON.parse(response.body) as { error?: string; message?: string } : {}
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(data.error ?? `Bridge request failed with status ${response.statusCode}`)
  }

  return data.message ?? "ok"
}
