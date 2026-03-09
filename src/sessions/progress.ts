import { Chunk, Deferred, Effect, Queue } from "effect"
import type { Message, SendableChannels } from "discord.js"
import type { Event, ToolPart } from "@opencode-ai/sdk/v2"

import { compactionCardContent } from "@/discord/compaction-card.ts"
import { editInfoCard, upsertInfoCard } from "@/discord/info-card.ts"
import { sendProgressUpdate } from "@/discord/messages.ts"
import { editToolCard, upsertToolCard } from "@/discord/tool-card.ts"
import {
  formatPatchUpdated,
  formatSessionStatus,
  formatThinkingCompleted,
} from "@/discord/progress.ts"
import {
  getCompactionPart,
  getPatchPart,
  getReasoningPart,
  getSessionCompacted,
  getSessionStatusUpdated,
  getToolPartUpdated,
} from "@/opencode/events.ts"
import type { RunFinalizationReason, RunProgressEvent } from "@/sessions/session.ts"

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
  activeToolParts: Map<string, ToolPart>
  todoCards: Message[]
  compactionCard: Message | null
  compactionPartIds: Set<string>
  retryStatusKeys: Set<string>
  completedReasoningPartIds: Set<string>
}

const createProgressState = (): ProgressState => ({
  patchPartIds: new Set<string>(),
  toolStates: new Map<string, string>(),
  toolCards: new Map<string, Message>(),
  activeToolParts: new Map<string, ToolPart>(),
  todoCards: [],
  compactionCard: null,
  compactionPartIds: new Set<string>(),
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
    case "session-compacting":
    case "session-compacted":
      return null
    case "session-status":
      if (event.status.type === "retry") {
        const key = `${event.status.attempt}:${event.status.message}`
        if (state.retryStatusKeys.has(key)) {
          return null
        }
        state.retryStatusKeys.add(key)
      }
      return formatSessionStatus(event.status)
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

const trackLiveToolState = (
  state: ProgressState,
  part: ToolPart,
) => {
  if (part.state.status === "pending" || part.state.status === "running") {
    state.activeToolParts.set(part.callID, part)
    return
  }

  state.activeToolParts.delete(part.callID)
}

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
    trackLiveToolState(state, event.part)

    if (todoTool) {
      yield* deletePreviousTodoCards(state, card)
    }
  })

const handleCompactionCard = (
  state: ProgressState,
  message: Message,
  event: Extract<RunProgressEvent, { type: "session-compacting" | "session-compacted" }>,
) =>
  Effect.gen(function* () {
    if (!message.channel.isSendable()) {
      throw new Error("Channel is not sendable for compaction card")
    }
    const channel = message.channel as SendableChannels

    if (event.type === "session-compacting") {
      if (state.compactionPartIds.has(event.part.id)) {
        return
      }
      state.compactionPartIds.add(event.part.id)
      const compactingCard = compactionCardContent("compacting")
      state.compactionCard = yield* Effect.promise(() =>
        upsertInfoCard({
          channel,
          existingCard: state.compactionCard,
          title: compactingCard.title,
          body: compactingCard.body,
        }),
      )
      return
    }

    const compactedCard = compactionCardContent("compacted")
    yield* Effect.promise(() =>
      upsertInfoCard({
        channel,
        existingCard: state.compactionCard,
        title: compactedCard.title,
        body: compactedCard.body,
      }),
    )
    state.compactionCard = null
  })

const finalizeLiveCards = (
  state: ProgressState,
  workdir: string,
  reason: RunFinalizationReason,
) =>
  Effect.gen(function* () {
    const terminalState = reason === "interrupted" ? "interrupted" : "shutdown"

    yield* Effect.forEach(
      state.activeToolParts.entries(),
      ([callId, part]) => {
        const card = state.toolCards.get(callId)
        if (!card) {
          return Effect.void
        }

        return Effect.promise(() =>
          editToolCard({
            card,
            part,
            workdir,
            terminalState,
          }),
        ).pipe(Effect.ignore)
      },
      { concurrency: "unbounded", discard: true },
    )

    state.activeToolParts.clear()

    if (!state.compactionCard) {
      return
    }

    const compactionState = reason === "interrupted" ? "interrupted" : "stopped"
    const { title, body } = compactionCardContent(compactionState)
    yield* Effect.promise(() => editInfoCard(state.compactionCard!, title, body)).pipe(Effect.ignore)
    state.compactionCard = null
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

  const sessionStatus = getSessionStatusUpdated(event)
  if (sessionStatus) {
    progressEvents.push({
      type: "session-status",
      status: sessionStatus.status,
    })
  }

  const compactionPart = getCompactionPart(event)
  if (compactionPart) {
    progressEvents.push({
      type: "session-compacting",
      part: compactionPart,
    })
  }

  const compacted = getSessionCompacted(event)
  if (compacted) {
    progressEvents.push({
      type: "session-compacted",
      compacted,
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
          if (event.reason) {
            yield* finalizeLiveCards(state, workdir, event.reason)
          }
          yield* Deferred.succeed(event.ack, undefined).pipe(Effect.ignore)
          continue
        }

        if (event.type === "tool-updated") {
          yield* handleToolCard(state, message, workdir, event)
          continue
        }

        if (event.type === "session-compacting" || event.type === "session-compacted") {
          yield* handleCompactionCard(state, message, event)
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
