import { createOpencode, createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { Cause, Chunk, Context, Effect, Layer } from "effect"

import { AppConfig } from "../config.ts"
import { Logger, type LoggerShape } from "../util/logging.ts"

export type SessionHandle = {
  sessionId: string
  client: OpencodeClient
  workdir: string
}

export type PromptResult = {
  messageId: string
  transcript: string
}

export type OpencodeServiceShape = {
  createSession: (workdir: string, title: string) => Effect.Effect<SessionHandle>
  prompt: (session: SessionHandle, prompt: string) => Effect.Effect<PromptResult>
}

export class OpencodeService extends Context.Tag("OpencodeService")<OpencodeService, OpencodeServiceShape>() {}

const formatValue = (value: unknown) => {
  if (value === undefined || value === null) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const renderTranscript = (parts: Array<any>) => {
  const lines: Array<string> = []

  for (const part of parts) {
    switch (part.type) {
      case "text": {
        if (part.text?.trim()) {
          lines.push(part.text.trim())
        }
        break
      }
      case "reasoning": {
        if (part.text?.trim()) {
          lines.push(`[Reasoning]\n${part.text.trim()}`)
        }
        break
      }
      case "tool": {
        const status = part.state?.status ?? "unknown"
        const title = part.state?.title ? ` | ${part.state.title}` : ""
        lines.push(`[Tool] ${part.tool} | ${status}${title}`)
        if (part.state?.input !== undefined) {
          lines.push(`input: ${formatValue(part.state.input)}`)
        }
        if (typeof part.state?.output === "string" && part.state.output.trim().length > 0) {
          lines.push(`output: ${part.state.output.trim()}`)
        }
        if (typeof part.state?.error === "string" && part.state.error.trim().length > 0) {
          lines.push(`error: ${part.state.error.trim()}`)
        }
        break
      }
      default:
        break
    }
  }

  return lines.join("\n\n").trim()
}

const consumeEvents = (input: {
  client: OpencodeClient
  logger: LoggerShape
  signal: AbortSignal
}) =>
  Effect.tryPromise(async () => {
    const events = await input.client.global.event({
      signal: input.signal,
      onSseError: (error) => {
        void Effect.runPromise(
          input.logger.warn("opencode event stream error", {
            error: String(error),
          }),
        )
      },
    })

    for await (const wrapped of events.stream) {
      const payload = (wrapped as { payload?: { type?: string; properties?: Record<string, unknown> } }).payload
      if (!payload?.type) {
        continue
      }

      if (
        payload.type === "session.status" ||
        payload.type === "session.error" ||
        payload.type === "session.idle" ||
        payload.type === "message.updated" ||
        payload.type === "message.part.updated"
      ) {
        await Effect.runPromise(
          input.logger.info("opencode event", {
            type: payload.type,
            properties: payload.properties,
          }),
        )
      }
    }
  })

const isExpectedAbort = (cause: Cause.Cause<unknown>, signal: AbortSignal) =>
  signal.aborted ||
  Cause.isInterruptedOnly(cause) ||
  Chunk.toReadonlyArray(Cause.failures(cause)).some(
    (error: unknown) => error instanceof DOMException || (error instanceof Error && error.name === "AbortError"),
  )

export const OpencodeServiceLive = Layer.scoped(
  OpencodeService,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const logger = yield* Logger
    yield* logger.info("starting opencode server", {
      host: config.opencodeServerHost,
      port: config.opencodeServerPort,
    })

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previousBridgeUrl = process.env.OPENCODE_DISCORD_BRIDGE_URL
        const previousBridgeToken = process.env.OPENCODE_DISCORD_BRIDGE_TOKEN

        process.env.OPENCODE_DISCORD_BRIDGE_URL = `http://${config.toolBridgeHost}:${config.toolBridgePort}`
        process.env.OPENCODE_DISCORD_BRIDGE_TOKEN = config.toolBridgeToken

        return {
          previousBridgeUrl,
          previousBridgeToken,
        }
      }),
      ({ previousBridgeUrl, previousBridgeToken }) =>
        Effect.sync(() => {
          if (previousBridgeUrl === undefined) {
            delete process.env.OPENCODE_DISCORD_BRIDGE_URL
          } else {
            process.env.OPENCODE_DISCORD_BRIDGE_URL = previousBridgeUrl
          }

          if (previousBridgeToken === undefined) {
            delete process.env.OPENCODE_DISCORD_BRIDGE_TOKEN
          } else {
            process.env.OPENCODE_DISCORD_BRIDGE_TOKEN = previousBridgeToken
          }
        }),
    )

    const runtime = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        createOpencode({
          hostname: config.opencodeServerHost,
          port: config.opencodeServerPort,
          timeout: 10_000,
        }),
      ),
      ({ server }) =>
        Effect.gen(function* () {
          yield* logger.info("stopping opencode server")
          yield* Effect.sync(() => {
            server.close()
          })
        }),
    )

    yield* logger.info("opencode server ready", {
      url: runtime.server.url,
    })

    const abortController = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.sync(() => {
          controller.abort()
        }),
    )

    yield* consumeEvents({
      client: runtime.client,
      logger,
      signal: abortController.signal,
    }).pipe(
      Effect.tapErrorCause((cause) =>
        isExpectedAbort(cause, abortController.signal)
          ? Effect.void
          : logger.warn("opencode event stream closed unexpectedly", {
              error: Cause.pretty(cause),
            }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    )

    return {
      createSession: (workdir, title) =>
        Effect.gen(function* () {
          const client = createOpencodeClient({
            baseUrl: runtime.server.url,
            directory: workdir,
          })
          const result = yield* Effect.promise(() => client.session.create({ body: { title } }))
          if (result.error || !result.data) {
            throw new Error(`Failed to create opencode session: ${formatValue(result.error)}`)
          }

          yield* logger.info("created opencode session", {
            sessionId: result.data.id,
            workdir,
          })

          return {
            sessionId: result.data.id,
            client,
            workdir,
          } satisfies SessionHandle
        }),
      prompt: (session, prompt) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            session.client.session.prompt({
              path: { id: session.sessionId },
              body: {
                parts: [{ type: "text", text: prompt }],
              },
            }),
          )

          if (result.error || !result.data) {
            throw new Error(`Failed to prompt opencode: ${formatValue(result.error)}`)
          }

          return {
            messageId: result.data.info.id,
            transcript: renderTranscript(result.data.parts),
          } satisfies PromptResult
        }),
    } satisfies OpencodeServiceShape
  }),
)
