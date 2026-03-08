import { createOpencodeClient, type GlobalEvent, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { Cause, Chunk, Context, Effect, Fiber, Layer } from "effect"
import { fileURLToPath } from "node:url"

import { AppConfig } from "@/config.ts"
import { OpencodeEventQueue, type OpencodeEventQueueShape } from "@/opencode/events.ts"
import { renderTranscript } from "@/opencode/transcript.ts"
import { describeSandboxBackend, launchSandboxedServer, type ResolvedSandboxBackend } from "@/sandbox/backend.ts"
import { Logger, type LoggerShape } from "@/util/logging.ts"

export type SessionHandle = {
  sessionId: string
  client: OpencodeClient
  workdir: string
  backend: ResolvedSandboxBackend
  close: () => Effect.Effect<void>
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
    const resolvedBackend = describeSandboxBackend(config.sandboxBackend)

    yield* logger.info("configured opencode sandbox backend", {
      backend: resolvedBackend,
      configDir: OPENCODE_CONFIG_DIR,
    })

    if (resolvedBackend === "unsafe-dev") {
      yield* logger.warn("opencode sandbox backend is running in unsafe development mode", {
        platform: process.platform,
      })
    }

    return {
      createSession: (workdir, title) =>
        Effect.gen(function* () {
          const server = yield* Effect.promise(() =>
            launchSandboxedServer({
              config,
              configDir: OPENCODE_CONFIG_DIR,
              workdir,
            }),
          )

          const client = createOpencodeClient({
            baseUrl: server.url,
            directory: workdir,
          })
          const abortController = new AbortController()
          const eventFiber = yield* consumeEvents({
            client,
            eventQueue,
            logger,
            signal: abortController.signal,
          }).pipe(
            Effect.tapErrorCause((cause) =>
              isExpectedAbort(cause, abortController.signal)
                ? Effect.void
                : logger.warn("opencode event stream closed unexpectedly", {
                    backend: server.backend,
                    workdir,
                    error: Cause.pretty(cause),
                  }),
            ),
            Effect.ignore,
            Effect.fork,
          )

          const close = () =>
            Effect.gen(function* () {
              abortController.abort()
              yield* Fiber.interrupt(eventFiber)
              yield* Effect.sync(() => {
                server.close()
              })
            })

          try {
            const result = yield* Effect.promise(() => client.session.create({ title }))
            if (result.error || !result.data) {
              throw new Error(`Failed to create opencode session: ${formatValue(result.error)}`)
            }

            yield* logger.info("created opencode session", {
              sessionId: result.data.id,
              backend: server.backend,
              serverUrl: server.url,
              workdir,
            })

            return {
              sessionId: result.data.id,
              client,
              workdir,
              backend: server.backend,
              close,
            } satisfies SessionHandle
          } catch (error) {
            yield* close().pipe(Effect.ignore)
            throw error
          }
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
