import { createOpencode, createOpencodeClient, type GlobalEvent, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { Cause, Chunk, Context, Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"

import { AppConfig } from "@/config.ts"
import { OpencodeEventQueue, type OpencodeEventQueueShape } from "@/opencode/events.ts"
import { renderTranscript } from "@/opencode/transcript.ts"
import { Logger, type LoggerShape } from "@/util/logging.ts"

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

const LOCALHOST = "127.0.0.1"
const OPENCODE_CONFIG_DIR = fileURLToPath(new URL("../../opencode", import.meta.url))

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

const consumeEvents = (input: {
  client: OpencodeClient
  eventQueue: OpencodeEventQueueShape
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
      if (!wrapped || typeof wrapped !== "object" || !("payload" in wrapped)) {
        continue
      }

      const event = wrapped as GlobalEvent

      if (
        event.payload.type === "session.status" ||
        event.payload.type === "session.error" ||
        event.payload.type === "session.idle" ||
        event.payload.type === "message.updated" ||
        event.payload.type === "message.part.updated" ||
        event.payload.type === "permission.asked" ||
        event.payload.type === "permission.replied"
      ) {
        await Effect.runPromise(
          input.logger.info("opencode event", {
            type: event.payload.type,
            properties: event.payload.properties,
          }),
        )
      }

      await Effect.runPromise(input.eventQueue.publish(event))
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
    const eventQueue = yield* OpencodeEventQueue
    const logger = yield* Logger
    yield* logger.info("starting opencode server", {
      configDir: OPENCODE_CONFIG_DIR,
      host: LOCALHOST,
      port: config.opencodeServerPort,
    })

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previousBridgeUrl = process.env.OPENCODE_DISCORD_BRIDGE_URL
        const previousBridgeToken = process.env.OPENCODE_DISCORD_BRIDGE_TOKEN
        const previousConfigDir = process.env.OPENCODE_CONFIG_DIR

        process.env.OPENCODE_DISCORD_BRIDGE_URL = `http://${LOCALHOST}:${config.toolBridgePort}`
        process.env.OPENCODE_DISCORD_BRIDGE_TOKEN = config.toolBridgeToken
        process.env.OPENCODE_CONFIG_DIR = OPENCODE_CONFIG_DIR

        return {
          previousBridgeUrl,
          previousBridgeToken,
          previousConfigDir,
        }
      }),
      ({ previousBridgeUrl, previousBridgeToken, previousConfigDir }) =>
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

          if (previousConfigDir === undefined) {
            delete process.env.OPENCODE_CONFIG_DIR
          } else {
            process.env.OPENCODE_CONFIG_DIR = previousConfigDir
          }
        }),
    )

    const runtime = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        createOpencode({
          hostname: LOCALHOST,
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
      eventQueue,
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
          const result = yield* Effect.promise(() => client.session.create({ title }))
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
              sessionID: session.sessionId,
              parts: [{ type: "text", text: prompt }],
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
