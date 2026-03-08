import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import { Chunk, Context, Deferred, Effect, Fiber, FiberSet, Layer, Queue, Ref } from "effect"
import type { Message } from "discord.js"
import type { Event } from "@opencode-ai/sdk/v2"

import { AppConfig } from "@/config.ts"
import { formatErrorResponse } from "@/discord/formatting.ts"
import {
  buildBatchedOpencodePrompt,
  buildOpencodePrompt,
  buildQueuedFollowUpPrompt,
  sendFinalResponse,
  sendProgressUpdate,
  startTypingLoop,
  summarizeAttachments,
  summarizeEmbeds,
} from "@/discord/messages.ts"
import { upsertToolCard } from "@/discord/tool-card.ts"
import {
  formatPatchUpdated,
  formatPermissionAsked,
  formatPermissionReplied,
  formatSessionStatus,
  formatThinkingCompleted,
} from "@/discord/progress.ts"
import {
  OpencodeEventQueue,
  getEventSessionId,
  getPatchPart,
  getPermissionReplied,
  getPermissionUpdated,
  getReasoningPart,
  getSessionStatusUpdated,
  getToolPartUpdated,
} from "@/opencode/events.ts"
import type { Invocation } from "@/discord/triggers.ts"
import { OpencodeService } from "@/opencode/service.ts"
import type { ActiveRun, ChannelSession, RunProgressEvent, RunRequest } from "@/sessions/session.ts"
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

const SKIPPED_TOOL_CARD_NAMES = new Set(["send-file", "send-image", "react", "download-attachments"])

const collectProgressEvents = (event: Event): ReadonlyArray<RunProgressEvent> => {
  const progressEvents: RunProgressEvent[] = []

  const toolPart = getToolPartUpdated(event)
  if (toolPart) {
    progressEvents.push({
      type: "tool-updated",
      part: toolPart,
    })
  }

  const patchPart = getPatchPart(event)
  if (patchPart) {
    progressEvents.push({
      type: "patch-updated",
      part: patchPart,
    })
  }

  const permission = getPermissionUpdated(event)
  if (permission) {
    progressEvents.push({
      type: "permission-asked",
      permission,
    })
  }

  const permissionReply = getPermissionReplied(event)
  if (permissionReply) {
    progressEvents.push({
      type: "permission-replied",
      reply: permissionReply,
    })
  }

  const sessionStatus = getSessionStatusUpdated(event)
  if (sessionStatus) {
    progressEvents.push({
      type: "session-status",
      status: sessionStatus.status,
    })
  }

  const reasoningPart = getReasoningPart(event)
  if (reasoningPart?.time.end) {
    progressEvents.push({
      type: "reasoning-completed",
      partId: reasoningPart.id,
      text: reasoningPart.text,
    })
  }

  return progressEvents
}

export const ChannelSessionsLive = Layer.scoped(
  ChannelSessions,
  Effect.gen(function* () {
    const logger = yield* Logger
    const config = yield* AppConfig
    const opencode = yield* OpencodeService
    const eventQueue = yield* OpencodeEventQueue
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

    const getActiveRunForSessionId = (sessions: Map<string, ChannelSession>, sessionId: string) => {
      for (const session of sessions.values()) {
        if (session.opencode.sessionId === sessionId) {
          return session.activeRun
        }
      }
      return null
    }

    const progressUpdateForEvent = (event: RunProgressEvent, state: {
      patchPartIds: Set<string>
      toolStates: Map<string, string>
      toolCards: Map<string, Message>
      permissionReplies: Map<string, string>
      pendingPermissions: Set<string>
      retryStatusKeys: Set<string>
      completedReasoningPartIds: Set<string>
    }) => {
      switch (event.type) {
        case "run-finalizing":
          return null
        case "reasoning-completed": {
          if (state.completedReasoningPartIds.has(event.partId)) {
            return null
          }
          const thinkingText = event.text.trim()
          if (thinkingText.length === 0) {
            return null
          }
          state.completedReasoningPartIds.add(event.partId)
          return formatThinkingCompleted(thinkingText)
        }
        case "patch-updated": {
          if (state.patchPartIds.has(event.part.id)) {
            return null
          }
          state.patchPartIds.add(event.part.id)
          return formatPatchUpdated(event.part)
        }
        case "session-status":
          if (event.status.type === "retry") {
            const key = `${event.status.attempt}:${event.status.message}`
            if (state.retryStatusKeys.has(key)) {
              return null
            }
            state.retryStatusKeys.add(key)
          }
          return formatSessionStatus(event.status)
        case "permission-asked": {
          if (state.pendingPermissions.has(event.permission.id)) {
            return null
          }
          state.pendingPermissions.add(event.permission.id)
          return formatPermissionAsked(event.permission)
        }
        case "permission-replied": {
          const previousReply = state.permissionReplies.get(event.reply.requestID)
          if (previousReply === event.reply.reply) {
            return null
          }
          state.permissionReplies.set(event.reply.requestID, event.reply.reply)
          return formatPermissionReplied(event.reply)
        }
      }
    }

    const runProgressWorker = (message: Message, workdir: string, queue: Queue.Queue<RunProgressEvent>) =>
      Effect.gen(function* () {
        const state = {
          patchPartIds: new Set<string>(),
          toolStates: new Map<string, string>(),
          toolCards: new Map<string, Message>(),
          todoCards: new Array<Message>(),
          permissionReplies: new Map<string, string>(),
          pendingPermissions: new Set<string>(),
          retryStatusKeys: new Set<string>(),
          completedReasoningPartIds: new Set<string>(),
        }

        const isTodoTool = (tool: string) => tool === "todowrite"

        const shouldSkipToolUpdate = (event: Extract<RunProgressEvent, { type: "tool-updated" }>) => {
          if (SKIPPED_TOOL_CARD_NAMES.has(event.part.tool)) {
            return true
          }
          if (isTodoTool(event.part.tool) && event.part.state.status !== "completed") {
            return true
          }
          const title = event.part.state.status === "running" || event.part.state.status === "completed" ? event.part.state.title : ""
          const nextKey = `${event.part.state.status}:${title}`
          const previousKey = state.toolStates.get(event.part.callID)
          if (previousKey === nextKey) {
            return true
          }
          state.toolStates.set(event.part.callID, nextKey)
          return false
        }

        const deletePreviousTodoCards = (currentCard: Message) =>
          Effect.gen(function* () {
            for (const previousTodoCard of state.todoCards) {
              if (previousTodoCard.id === currentCard.id) {
                continue
              }
              yield* Effect.promise(() => previousTodoCard.delete()).pipe(Effect.ignore)
            }
            state.todoCards = [currentCard]
          })

        const handleToolCard = (event: Extract<RunProgressEvent, { type: "tool-updated" }>) =>
          Effect.gen(function* () {
            if (shouldSkipToolUpdate(event)) {
              return
            }

            const todoTool = isTodoTool(event.part.tool)
            const existingCard = state.toolCards.get(event.part.callID) ?? null
            const card = yield* Effect.promise(() =>
              upsertToolCard({
                sourceMessage: message,
                existingCard: todoTool ? null : existingCard,
                workdir,
                part: event.part,
                mode: todoTool ? "always-send" : "edit-or-send",
              }),
            )
            state.toolCards.set(event.part.callID, card)

            if (todoTool) {
              yield* deletePreviousTodoCards(card)
            }
          })

        while (true) {
          const first = yield* Queue.take(queue)
          const rest = yield* Queue.takeUpTo(queue, 64)
          const batch = [first, ...Chunk.toReadonlyArray(rest)]

          for (const event of batch) {
            if (event.type === "run-finalizing") {
              progressUpdateForEvent(event, state)
              yield* Deferred.succeed(event.ack, undefined).pipe(Effect.ignore)
              continue
            }

            if (event.type === "tool-updated") {
              yield* handleToolCard(event)
              continue
            }

            const update = progressUpdateForEvent(event, state)
            if (!update) {
              continue
            }
            yield* Effect.promise(() => sendProgressUpdate({ message, text: update }))
          }
        }
      })

    yield* eventQueue.take().pipe(
      Effect.flatMap((wrapped) => {
        const sessionId = getEventSessionId(wrapped.payload)
        if (!sessionId) {
          return Effect.void
        }

        return Ref.get(sessionsRef).pipe(
          Effect.flatMap((sessions) => {
            const activeRun = getActiveRunForSessionId(sessions, sessionId)
            if (!activeRun) {
              return Effect.void
            }

            const progressEvents = collectProgressEvents(wrapped.payload)

            return Effect.forEach(progressEvents, (progressEvent) =>
              Queue.offer(activeRun.progressQueue, progressEvent).pipe(Effect.asVoid),
            ).pipe(Effect.asVoid)
          }),
        )
      }),
      Effect.forever,
      Effect.catchAll((error) =>
        logger.error("opencode event dispatcher failed", {
          error: formatError(error),
        }),
      ),
      Effect.forkScoped,
    )

    const processRequestBatch = (session: ChannelSession, initialRequests: ReadonlyArray<RunRequest>) =>
      Effect.gen(function* () {
        const progressQueue = yield* Queue.unbounded<RunProgressEvent>()
        const followUpQueue = yield* Queue.unbounded<RunRequest>()
        const acceptFollowUps = yield* Ref.make(true)
        const responseMessage = initialRequests[0]!.message
        const progressFiber = yield* runProgressWorker(responseMessage, session.workdir, progressQueue).pipe(Effect.fork)

        yield* setActiveRun(session.channelId, {
          discordMessage: responseMessage,
          workdir: session.workdir,
          progressQueue,
          followUpQueue,
          acceptFollowUps,
        })

        const stopTyping = startTypingLoop(responseMessage.channel)

        try {
          let currentBatch: ReadonlyArray<RunRequest> = initialRequests
          let result = yield* opencode.prompt(
            session.opencode,
            buildBatchedOpencodePrompt(currentBatch.map((request) => request.prompt)),
          )

          while (true) {
            yield* Ref.set(acceptFollowUps, false)
            const followUps = yield* Queue.takeAll(followUpQueue).pipe(Effect.map(Chunk.toReadonlyArray))
            if (followUps.length === 0) {
              break
            }

            yield* logger.info("absorbing queued follow-up messages into active run", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              count: followUps.length,
            })

            currentBatch = followUps
            yield* Ref.set(acceptFollowUps, true)
            result = yield* opencode.prompt(
              session.opencode,
              buildQueuedFollowUpPrompt(currentBatch.map((request) => request.prompt)),
            )
          }

          const finalizingAck = yield* Deferred.make<void>()
          const progressFiberExit = yield* progressFiber.poll
          if (progressFiberExit._tag === "None") {
            yield* Queue.offer(progressQueue, { type: "run-finalizing", ack: finalizingAck })
            const finalizingResult = yield* Deferred.await(finalizingAck).pipe(Effect.timeoutOption("2 seconds"))
            if (finalizingResult._tag === "None") {
              yield* logger.warn("progress worker finalization timed out", {
                channelId: session.channelId,
                sessionId: session.opencode.sessionId,
              })
            }
          } else {
            yield* logger.warn("progress worker exited before finalization", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              exit: String(progressFiberExit.value),
            })
          }

          yield* Effect.promise(() => sendFinalResponse({ message: responseMessage, text: result.transcript }))
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
            responseMessage.reply({
              content: formatErrorResponse("## ❌ Opencode failed", formatError(error)),
              allowedMentions: { repliedUser: false, parse: [] },
            }),
          )
        } finally {
          stopTyping()
          yield* setActiveRun(session.channelId, null)
          yield* Fiber.interrupt(progressFiber)
        }
      })

    const worker = (session: ChannelSession) =>
      Effect.forever(
        Queue.take(session.queue).pipe(
          Effect.flatMap((first) =>
            Queue.takeUpTo(session.queue, 64).pipe(
              Effect.flatMap((rest) => processRequestBatch(session, [first, ...Chunk.toReadonlyArray(rest)])),
            ),
          ),
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
          backend: opencodeSession.backend,
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
          yield* session.opencode.close().pipe(Effect.ignore)
          yield* Effect.promise(() => rm(resolve(session.workdir), { recursive: true, force: true }))
        }
        yield* FiberSet.clear(fiberSet)
      }),
    )

    return {
      submit: (message, invocation) =>
        Effect.gen(function* () {
          yield* getOrCreateSession(message)
          const session = yield* getSession(message.channelId)
          if (!session) {
            throw new Error(`Channel session not found for ${message.channelId}`)
          }
          const prompt = buildOpencodePrompt({
            userTag: message.author.tag,
            content: invocation.prompt,
            replyContext: invocation.replyContext,
            attachmentSummary: summarizeAttachments(message),
            embedSummary: summarizeEmbeds(message),
          })

          const request = {
            message,
            prompt,
          } satisfies RunRequest

          if (session.activeRun) {
            const acceptFollowUps = yield* Ref.get(session.activeRun.acceptFollowUps)
            if (acceptFollowUps) {
              yield* Queue.offer(session.activeRun.followUpQueue, request)
              yield* logger.info("queued follow-up on active run", {
                channelId: message.channelId,
                sessionId: session.opencode.sessionId,
                author: message.author.tag,
              })
              return
            }
          }

          yield* Queue.offer(session.queue, request)

          yield* logger.info("queued run", {
            channelId: message.channelId,
            sessionId: session.opencode.sessionId,
            author: message.author.tag,
          })
        }),
      getActiveRunBySessionId: (sessionId) =>
        Ref.get(sessionsRef).pipe(
          Effect.map((sessions) => getActiveRunForSessionId(sessions, sessionId)),
        ),
    } satisfies ChannelSessionsShape
  }),
)
