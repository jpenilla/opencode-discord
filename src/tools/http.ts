import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"

import { Context, Effect, Layer } from "effect"
import type { Message as DiscordMessage } from "discord.js"

import { AppConfig } from "@/config.ts"
import { ChannelSessions } from "@/sessions/registry.ts"
import { Logger } from "@/util/logging.ts"

export type ToolBridgeShape = {
  socketPath: string
}

export class ToolBridge extends Context.Tag("ToolBridge")<ToolBridge, ToolBridgeShape>() {}

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

const sendJson = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

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

const fetchReferencedMessage = async (message: DiscordMessage) => {
  if (!message.reference?.messageId) {
    return null
  }

  return message.fetchReference().catch(() => null)
}

const readJsonBody = async (request: IncomingMessage): Promise<ToolRequest | undefined> => {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) {
    return undefined
  }

  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
  return JSON.parse(raw) as ToolRequest
}

export const ToolBridgeLive = Layer.scoped(
  ToolBridge,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const logger = yield* Logger
    const sessions = yield* ChannelSessions

    yield* Effect.promise(() => mkdir(dirname(config.toolBridgeSocketPath), { recursive: true }))
    yield* Effect.promise(() => rm(config.toolBridgeSocketPath, { force: true }))

    const server = createServer(async (request, response) => {
      try {
        if (request.headers["x-opencode-discord-token"] !== config.toolBridgeToken) {
          sendJson(response, { error: "unauthorized" }, 401)
          return
        }

        let payload: ToolRequest | undefined
        try {
          payload = await readJsonBody(request)
        } catch {
          sendJson(response, { error: "invalid json" }, 400)
          return
        }

        if (!payload?.sessionID) {
          sendJson(response, { error: "missing sessionID" }, 400)
          return
        }

        const activeRun = await Effect.runPromise(sessions.getActiveRunBySessionId(payload.sessionID))
        if (!activeRun) {
          sendJson(response, { error: "no active run for session" }, 409)
          return
        }

        const pathname = new URL(request.url ?? "/", "http://localhost").pathname

        if (request.method === "POST" && pathname === "/tool/send-file") {
          if (!payload.path) {
            sendJson(response, { error: "missing path" }, 400)
            return
          }
          if (!insideDirectory(activeRun.workdir, payload.path)) {
            sendJson(response, { error: "path outside session workdir" }, 403)
            return
          }
          const filePath = isAbsolute(payload.path) ? resolve(payload.path) : resolve(activeRun.workdir, payload.path)

          if (!activeRun.discordMessage.channel.isSendable()) {
            sendJson(response, { error: "channel not sendable" }, 409)
            return
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            files: [filePath],
            allowedMentions: { parse: ["users", "roles", "everyone"] },
          })

          sendJson(response, { ok: true, message: `Sent file ${payload.path}` })
          return
        }

        if (request.method === "POST" && pathname === "/tool/send-image") {
          if (!payload.path) {
            sendJson(response, { error: "missing path" }, 400)
            return
          }
          if (!insideDirectory(activeRun.workdir, payload.path)) {
            sendJson(response, { error: "path outside session workdir" }, 403)
            return
          }
          const imagePath = isAbsolute(payload.path) ? resolve(payload.path) : resolve(activeRun.workdir, payload.path)

          if (!activeRun.discordMessage.channel.isSendable()) {
            sendJson(response, { error: "channel not sendable" }, 409)
            return
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            files: [imagePath],
            allowedMentions: { parse: ["users", "roles", "everyone"] },
          })

          sendJson(response, { ok: true, message: `Sent image ${payload.path}` })
          return
        }

        if (request.method === "POST" && pathname === "/tool/react") {
          if (!payload.emoji) {
            sendJson(response, { error: "missing emoji" }, 400)
            return
          }
          await activeRun.discordMessage.react(payload.emoji)
          sendJson(response, { ok: true, message: `Added reaction ${payload.emoji}` })
          return
        }

        if (request.method === "POST" && pathname === "/tool/download-attachments") {
          const referencedMessage = await fetchReferencedMessage(activeRun.discordMessage)
          const targetDirectory = resolve(activeRun.workdir, payload.directory ?? ".")
          if (!insideDirectory(activeRun.workdir, targetDirectory)) {
            sendJson(response, { error: "directory outside session workdir" }, 403)
            return
          }

          const attachments = [
            ...[...activeRun.discordMessage.attachments.values()].map((attachment) => ({
              attachment,
              source: "triggering message",
            })),
            ...(referencedMessage
              ? [...referencedMessage.attachments.values()].map((attachment) => ({
                  attachment,
                  source: "replied-to message",
                }))
              : []),
          ]
          if (attachments.length === 0) {
            sendJson(response, { error: "no attachments on triggering or replied-to message" }, 409)
            return
          }

          await mkdir(targetDirectory, { recursive: true })

          const downloaded: Array<{
            savedPath: string
            originalName: string
            source: string
          }> = []
          for (const { attachment, source } of attachments) {
            const download = await fetch(attachment.url)
            if (!download.ok) {
              sendJson(response, { error: `failed to download attachment: ${attachment.url}` }, 502)
              return
            }

            const arrayBuffer = await download.arrayBuffer()
            const filename = sanitizeFilename(attachment.name ?? attachment.id)
            const destination = await uniquePath(targetDirectory, filename)
            await writeFile(destination, new Uint8Array(arrayBuffer))
            downloaded.push({
              savedPath: relative(activeRun.workdir, destination),
              originalName: attachment.name ?? attachment.id,
              source,
            })
          }

          sendJson(response, {
            ok: true,
            message: [
              `Downloaded ${downloaded.length} attachment${downloaded.length === 1 ? "" : "s"}:`,
              ...downloaded.map(
                ({ savedPath, originalName, source }) =>
                  `- \`./${savedPath}\` from ${source} (\`${originalName}\`)`,
              ),
            ].join("\n"),
          })
          return
        }

        sendJson(response, { error: "not found" }, 404)
      } catch (error) {
        await Effect.runPromise(
          logger.error("tool bridge request failed", {
            error: String(error),
          }),
        )
        sendJson(response, { error: "internal error" }, 500)
      }
    })

    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off("listening", onListening)
            reject(error)
          }
          const onListening = () => {
            server.off("error", onError)
            resolve()
          }

          server.once("error", onError)
          server.once("listening", onListening)
          server.listen(config.toolBridgeSocketPath)
        }),
    )

    yield* logger.info("started tool bridge", {
      socketPath: config.toolBridgeSocketPath,
    })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error) {
                  reject(error)
                  return
                }
                resolve()
              })
            }),
        ).pipe(Effect.ignore)
        yield* Effect.promise(() => rm(config.toolBridgeSocketPath, { force: true })).pipe(Effect.ignore)
      }),
    )

    return {
      socketPath: config.toolBridgeSocketPath,
    } satisfies ToolBridgeShape
  }),
)
