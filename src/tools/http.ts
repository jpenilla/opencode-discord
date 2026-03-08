import { Context, Effect, Layer } from "effect"
import { basename, isAbsolute, relative, resolve } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

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
  directory?: string
  caption?: string
  emoji?: string
}

const insideDirectory = (root: string, candidate: string) => {
  const rootPath = resolve(root)
  const candidatePath = isAbsolute(candidate) ? resolve(candidate) : resolve(rootPath, candidate)
  const rel = relative(rootPath, candidatePath)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const sanitizeFilename = (value: string) => {
  const name = basename(value).trim()
  const safe = name.replace(/[/\\:\0]/g, "_")
  return safe.length > 0 ? safe : "attachment.bin"
}

const uniquePath = async (directory: string, filename: string) => {
  const dot = filename.lastIndexOf(".")
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ""

  let attempt = 0
  while (true) {
    const candidate = resolve(directory, attempt === 0 ? filename : `${base}-${attempt}${ext}`)
    const file = Bun.file(candidate)
    if (!(await file.exists())) {
      return candidate
    }
    attempt += 1
  }
}

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
          const filePath = isAbsolute(payload.path) ? resolve(payload.path) : resolve(activeRun.workdir, payload.path)

          if (!activeRun.discordMessage.channel.isSendable()) {
            return json({ error: "channel not sendable" }, 409)
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            files: [filePath],
            allowedMentions: { parse: ["users", "roles", "everyone"] },
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
          const imagePath = isAbsolute(payload.path) ? resolve(payload.path) : resolve(activeRun.workdir, payload.path)

          if (!activeRun.discordMessage.channel.isSendable()) {
            return json({ error: "channel not sendable" }, 409)
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            files: [imagePath],
            allowedMentions: { parse: ["users", "roles", "everyone"] },
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

        if (request.method === "POST" && request.url.endsWith("/tool/download-attachments")) {
          const targetDirectory = resolve(activeRun.workdir, payload.directory ?? ".")
          if (!insideDirectory(activeRun.workdir, targetDirectory)) {
            return json({ error: "directory outside session workdir" }, 403)
          }

          const attachments = [...activeRun.discordMessage.attachments.values()]
          if (attachments.length === 0) {
            return json({ error: "no attachments on triggering message" }, 409)
          }

          await mkdir(targetDirectory, { recursive: true })

          const downloaded: string[] = []
          for (const attachment of attachments) {
            const response = await fetch(attachment.url)
            if (!response.ok) {
              return json({ error: `failed to download attachment: ${attachment.url}` }, 502)
            }

            const arrayBuffer = await response.arrayBuffer()
            const filename = sanitizeFilename(attachment.name ?? attachment.id)
            const destination = await uniquePath(targetDirectory, filename)
            await writeFile(destination, new Uint8Array(arrayBuffer))
            downloaded.push(relative(activeRun.workdir, destination))
          }

          return json({
            ok: true,
            message: `Downloaded ${downloaded.length} attachment${downloaded.length === 1 ? "" : "s"}: ${downloaded
              .map((path) => `./${path}`)
              .join(", ")}`,
          })
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
