import { Context, Effect, Layer } from "effect"
import { resolve, relative, isAbsolute } from "node:path"

import { AppConfig } from "@/config.ts"
import { ChannelSessions } from "@/sessions/registry.ts"
import { Logger } from "@/util/logging.ts"

export type ToolBridgeShape = {
  url: string
}

export class ToolBridge extends Context.Tag("ToolBridge")<ToolBridge, ToolBridgeShape>() {}

const LOCALHOST = "127.0.0.1"

type ToolRequest = {
  sessionID: string
  path?: string
  caption?: string
  emoji?: string
}

const insideDirectory = (root: string, candidate: string) => {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  const rel = relative(rootPath, candidatePath)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

export const ToolBridgeLive = Layer.scoped(
  ToolBridge,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const logger = yield* Logger
    const sessions = yield* ChannelSessions

    const server = Bun.serve({
      hostname: LOCALHOST,
      port: config.toolBridgePort,
      async fetch(request) {
        if (request.headers.get("x-opencode-discord-token") !== config.toolBridgeToken) {
          return json({ error: "unauthorized" }, 401)
        }

        let payload: ToolRequest
        try {
          payload = (await request.json()) as ToolRequest
        } catch {
          return json({ error: "invalid json" }, 400)
        }

        if (!payload.sessionID) {
          return json({ error: "missing sessionID" }, 400)
        }

        const activeRun = await Effect.runPromise(sessions.getActiveRunBySessionId(payload.sessionID))
        if (!activeRun) {
          return json({ error: "no active run for session" }, 409)
        }

        if (request.method === "POST" && request.url.endsWith("/tool/send-file")) {
          if (!payload.path) {
            return json({ error: "missing path" }, 400)
          }
          if (!insideDirectory(activeRun.workdir, payload.path)) {
            return json({ error: "path outside session workdir" }, 403)
          }

          if (!activeRun.discordMessage.channel.isSendable()) {
            return json({ error: "channel not sendable" }, 409)
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            files: [resolve(payload.path)],
            allowedMentions: { parse: [] },
          })

          return json({ ok: true, message: `Sent file ${payload.path}` })
        }

        if (request.method === "POST" && request.url.endsWith("/tool/send-image")) {
          if (!payload.path) {
            return json({ error: "missing path" }, 400)
          }
          if (!insideDirectory(activeRun.workdir, payload.path)) {
            return json({ error: "path outside session workdir" }, 403)
          }

          if (!activeRun.discordMessage.channel.isSendable()) {
            return json({ error: "channel not sendable" }, 409)
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            files: [resolve(payload.path)],
            allowedMentions: { parse: [] },
          })

          return json({ ok: true, message: `Sent image ${payload.path}` })
        }

        if (request.method === "POST" && request.url.endsWith("/tool/react")) {
          if (!payload.emoji) {
            return json({ error: "missing emoji" }, 400)
          }
          await activeRun.discordMessage.react(payload.emoji)
          return json({ ok: true, message: `Added reaction ${payload.emoji}` })
        }

        return json({ error: "not found" }, 404)
      },
      error(error) {
        void Effect.runPromise(
          logger.error("tool bridge request failed", {
            error: String(error),
          }),
        )
        return json({ error: "internal error" }, 500)
      },
    })

    yield* logger.info("started tool bridge", {
      host: LOCALHOST,
      port: config.toolBridgePort,
    })

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.stop(true)
      }),
    )

    return {
      url: `http://${LOCALHOST}:${config.toolBridgePort}`,
    } satisfies ToolBridgeShape
  }),
)
