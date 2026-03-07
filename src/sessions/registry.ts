import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import { Context, Effect, FiberSet, Layer, Queue, Ref } from "effect"
import type { Message } from "discord.js"

import { AppConfig } from "@/config.ts"
import { buildOpencodePrompt, sendFinalResponse, startTypingLoop, summarizeAttachments, summarizeEmbeds } from "@/discord/messages.ts"
import type { Invocation } from "@/discord/triggers.ts"
import { OpencodeService } from "@/opencode/service.ts"
import type { ActiveRun, ChannelSession, RunRequest } from "@/sessions/session.ts"
import { Logger } from "@/util/logging.ts"

export type ChannelSessionsShape = {
  submit: (message: Message, invocation: Invocation) => Effect.Effect<void>
  getActiveRunBySessionId: (sessionId: string) => Effect.Effect<ActiveRun | null>
}

export class ChannelSessions extends Context.Tag("ChannelSessions")<ChannelSessions, ChannelSessionsShape>() {}

const formatError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export const ChannelSessionsLive = Layer.scoped(
  ChannelSessions,
  Effect.gen(function* () {
    const logger = yield* Logger
    const config = yield* AppConfig
    const opencode = yield* OpencodeService
    const sessionsRef = yield* Ref.make(new Map<string, ChannelSession>())
    const fiberSet = yield* FiberSet.make()

    const setActiveRun = (channelId: string, activeRun: ActiveRun | null) =>
      Ref.update(sessionsRef, (current) => {
        const next = new Map(current)
        const session = next.get(channelId)
        if (!session) {
          return current
        }
        next.set(channelId, {
          ...session,
          activeRun,
        })
        return next
      })

    const getSession = (channelId: string) => Ref.get(sessionsRef).pipe(Effect.map((sessions) => sessions.get(channelId)))

    const processRequest = (session: ChannelSession, request: RunRequest) =>
      Effect.gen(function* () {
        yield* setActiveRun(session.channelId, {
          discordMessage: request.message,
          workdir: session.workdir,
        })

        const stopTyping = startTypingLoop(request.message.channel)

        try {
          const result = yield* opencode.prompt(session.opencode, request.prompt)
          yield* Effect.promise(() => sendFinalResponse({ message: request.message, text: result.transcript }))
          yield* logger.info("completed run", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            opencodeMessageId: result.messageId,
          })
        } catch (error) {
          yield* logger.error("run failed", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: formatError(error),
          })
          yield* Effect.promise(() =>
            request.message.reply({
              content: `Opencode failed: ${formatError(error)}`,
              allowedMentions: { repliedUser: false, parse: [] },
            }),
          )
        } finally {
          stopTyping()
          yield* setActiveRun(session.channelId, null)
        }
      })

    const worker = (session: ChannelSession) =>
      Effect.forever(
        Queue.take(session.queue).pipe(
          Effect.flatMap((request) => processRequest(session, request)),
          Effect.catchAll((error) =>
            logger.error("channel worker iteration failed", {
              channelId: session.channelId,
              error: formatError(error),
            }),
          ),
        ),
      )

    const createSession = (message: Message) =>
      Effect.gen(function* () {
        const workdir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "opencode-discord-")))
        const opencodeSession = yield* opencode.createSession(workdir, `Discord #${message.channelId}`)
        const queue = yield* Queue.unbounded<RunRequest>()

        const session: ChannelSession = {
          channelId: message.channelId,
          opencode: opencodeSession,
          workdir,
          queue,
          activeRun: null,
        }

        yield* Ref.update(sessionsRef, (current) => {
          const next = new Map(current)
          next.set(message.channelId, session)
          return next
        })

        yield* FiberSet.run(fiberSet, worker(session))
        yield* logger.info("created channel session", {
          channelId: message.channelId,
          sessionId: opencodeSession.sessionId,
          workdir,
          triggerPhrase: config.triggerPhrase,
        })

        return session
      })

    const getOrCreateSession = (message: Message) =>
      Effect.gen(function* () {
        const existing = yield* getSession(message.channelId)
        if (existing) {
          return existing
        }
        return yield* createSession(message)
      })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef)
        for (const session of sessions.values()) {
          yield* Queue.shutdown(session.queue)
          yield* Effect.promise(() => rm(resolve(session.workdir), { recursive: true, force: true }))
        }
        yield* FiberSet.clear(fiberSet)
      }),
    )

    return {
      submit: (message, invocation) =>
        Effect.gen(function* () {
          const session = yield* getOrCreateSession(message)
          const prompt = buildOpencodePrompt({
            userTag: message.author.tag,
            content: invocation.prompt,
            replyContext: invocation.replyContext,
            attachmentSummary: summarizeAttachments(message),
            embedSummary: summarizeEmbeds(message),
          })

          yield* Queue.offer(session.queue, {
            message,
            prompt,
          })

          yield* logger.info("queued run", {
            channelId: message.channelId,
            sessionId: session.opencode.sessionId,
            author: message.author.tag,
          })
        }),
      getActiveRunBySessionId: (sessionId) =>
        Ref.get(sessionsRef).pipe(
          Effect.map((sessions) => {
            for (const session of sessions.values()) {
              if (session.opencode.sessionId === sessionId) {
                return session.activeRun
              }
            }
            return null
          }),
        ),
    } satisfies ChannelSessionsShape
  }),
)
