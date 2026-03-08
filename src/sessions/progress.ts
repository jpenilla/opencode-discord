import { Chunk, Deferred, Effect, Queue } from "effect"
import type { Message } from "discord.js"
import type { Event } from "@opencode-ai/sdk/v2"

import { sendProgressUpdate } from "@/discord/messages.ts"
import { upsertToolCard } from "@/discord/tool-card.ts"
import {
  formatPatchUpdated,
  formatPermissionAsked,
  formatPermissionReplied,
  formatSessionStatus,
  formatThinkingCompleted,
} from "@/discord/progress.ts"
import {
  getPatchPart,
  getPermissionReplied,
  getPermissionUpdated,
  getReasoningPart,
  getSessionStatusUpdated,
  getToolPartUpdated,
} from "@/opencode/events.ts"
import type { RunProgressEvent } from "@/sessions/session.ts"

const SKIPPED_TOOL_CARD_NAMES = new Set([
  "send-file",
  "send-image",
  "react",
  "download-attachments",
  "list-custom-emojis",
  "list-stickers",
  "send-sticker",
  "question",
])

type ProgressState = {
  patchPartIds: Set<string>
  toolStates: Map<string, string>
  toolCards: Map<string, Message>
  todoCards: Message[]
  permissionReplies: Map<string, string>
  pendingPermissions: Set<string>
  retryStatusKeys: Set<string>
  completedReasoningPartIds: Set<string>
}

const createProgressState = (): ProgressState => ({
  patchPartIds: new Set<string>(),
  toolStates: new Map<string, string>(),
  toolCards: new Map<string, Message>(),
  todoCards: [],
  permissionReplies: new Map<string, string>(),
  pendingPermissions: new Set<string>(),
  retryStatusKeys: new Set<string>(),
  completedReasoningPartIds: new Set<string>(),
})

const isTodoTool = (tool: string) => tool === "todowrite"

const shouldSkipToolUpdate = (
  state: ProgressState,
  event: Extract<RunProgressEvent, { type: "tool-updated" }>,
) => {
  if (SKIPPED_TOOL_CARD_NAMES.has(event.part.tool)) {
    return true
  }
  if (isTodoTool(event.part.tool) && event.part.state.status !== "completed") {
    return true
  }

  const title =
    event.part.state.status === "running" || event.part.state.status === "completed" ? event.part.state.title : ""
  const nextKey = `${event.part.state.status}:${title}`
  const previousKey = state.toolStates.get(event.part.callID)
  if (previousKey === nextKey) {
    return true
  }

  state.toolStates.set(event.part.callID, nextKey)
  return false
}

const progressUpdateForEvent = (event: RunProgressEvent, state: ProgressState) => {
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

const deletePreviousTodoCards = (state: ProgressState, currentCard: Message) =>
  Effect.gen(function* () {
    for (const previousTodoCard of state.todoCards) {
      if (previousTodoCard.id === currentCard.id) {
        continue
      }
      yield* Effect.promise(() => previousTodoCard.delete()).pipe(Effect.ignore)
    }
    state.todoCards = [currentCard]
  })

const handleToolCard = (
  state: ProgressState,
  message: Message,
  workdir: string,
  event: Extract<RunProgressEvent, { type: "tool-updated" }>,
) =>
  Effect.gen(function* () {
    if (shouldSkipToolUpdate(state, event)) {
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
      yield* deletePreviousTodoCards(state, card)
    }
  })

export const collectProgressEvents = (event: Event): ReadonlyArray<RunProgressEvent> => {
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

export const runProgressWorker = (
  message: Message,
  workdir: string,
  queue: Queue.Queue<RunProgressEvent>,
): Effect.Effect<never, unknown> =>
  Effect.gen(function* () {
    const state = createProgressState()

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
          yield* handleToolCard(state, message, workdir, event)
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
