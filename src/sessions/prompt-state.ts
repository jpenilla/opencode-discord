import type { AssistantMessage, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { Deferred, Effect, Ref } from "effect"

import type { PromptResult } from "@/opencode/service.ts"

type TrackedAssistant = {
  info: AssistantMessage | null
  liveToolCallIds: Set<string>
}

export type PendingPrompt = {
  userMessageId: string | null
  deferred: Deferred.Deferred<PromptResult, unknown>
  assistantsByMessageId: Map<string, TrackedAssistant>
}

export type PromptTrackingAction =
  | {
    type: "complete-prompt"
    messageId: string
    deferred: Deferred.Deferred<PromptResult, unknown>
  }
  | {
    type: "fail-prompt"
    deferred: Deferred.Deferred<PromptResult, unknown>
    error: unknown
  }

const isPromptReply = (userMessageId: string, message: AssistantMessage) =>
  message.parentID === userMessageId

const isResolvablePromptReply = (message: AssistantMessage) =>
  message.error !== undefined ||
  (
    message.time.completed !== undefined &&
    message.finish !== "tool-calls" &&
    message.finish !== "unknown"
  )

const cloneTrackedAssistant = (tracked?: TrackedAssistant): TrackedAssistant => ({
  info: tracked?.info ?? null,
  liveToolCallIds: new Set(tracked?.liveToolCallIds ?? []),
})

const selectPromptReplyCandidate = (
  prompt: PendingPrompt,
): { messageId: string; tracked: TrackedAssistant } | null => {
  if (!prompt.userMessageId) {
    return null
  }

  let candidate: { messageId: string; tracked: TrackedAssistant } | null = null
  for (const [messageId, tracked] of prompt.assistantsByMessageId.entries()) {
    const info = tracked.info
    if (!info) {
      continue
    }
    if (!isPromptReply(prompt.userMessageId, info) || !isResolvablePromptReply(info) || tracked.liveToolCallIds.size > 0) {
      continue
    }

    candidate = { messageId, tracked }
  }

  return candidate
}

const evaluatePromptActions = (prompt: PendingPrompt): ReadonlyArray<PromptTrackingAction> => {
  const actions: PromptTrackingAction[] = []

  const candidate = selectPromptReplyCandidate(prompt)
  if (candidate?.tracked.info?.error) {
    actions.push({
      type: "fail-prompt",
      deferred: prompt.deferred,
      error: candidate.tracked.info.error,
    })
    return actions
  }

  if (candidate) {
    actions.push({
      type: "complete-prompt",
      messageId: candidate.messageId,
      deferred: prompt.deferred,
    })
    return actions
  }

  return actions
}

const shouldClearPrompt = (actions: ReadonlyArray<PromptTrackingAction>) =>
  actions.some((action) => action.type === "complete-prompt" || action.type === "fail-prompt")

const updatePendingPrompt = (
  stateRef: Ref.Ref<PendingPrompt | null>,
  transform: (current: PendingPrompt) => PendingPrompt,
): Effect.Effect<ReadonlyArray<PromptTrackingAction>> =>
  Ref.modify(stateRef, (current): readonly [ReadonlyArray<PromptTrackingAction>, PendingPrompt | null] => {
    if (!current) {
      return [[], null]
    }

    const nextPrompt = transform(current)
    const actions = evaluatePromptActions(nextPrompt)
    return [
      actions,
      shouldClearPrompt(actions) ? null : nextPrompt,
    ]
  })

const clonePrompt = (prompt: PendingPrompt): PendingPrompt => ({
  ...prompt,
  assistantsByMessageId: new Map(prompt.assistantsByMessageId),
})

export const handleSessionError = (
  stateRef: Ref.Ref<PendingPrompt | null>,
  error: unknown,
): Effect.Effect<ReadonlyArray<PromptTrackingAction>> =>
  Ref.modify(stateRef, (current): readonly [ReadonlyArray<PromptTrackingAction>, PendingPrompt | null] => {
    if (!current) {
      return [[], null]
    }

    return [[{
      type: "fail-prompt",
      deferred: current.deferred,
      error,
    }], null]
  })

export const resolvePromptTrackingActions = (
  actions: ReadonlyArray<PromptTrackingAction>,
): {
  completePrompt: Extract<PromptTrackingAction, { type: "complete-prompt" }> | null
  failPrompt: Extract<PromptTrackingAction, { type: "fail-prompt" }> | null
} => {
  let completePrompt: Extract<PromptTrackingAction, { type: "complete-prompt" }> | null = null
  let failPrompt: Extract<PromptTrackingAction, { type: "fail-prompt" }> | null = null

  for (const action of actions) {
    switch (action.type) {
      case "complete-prompt":
        completePrompt = action
        break
      case "fail-prompt":
        failPrompt = action
        break
    }
  }

  return {
    completePrompt,
    failPrompt,
  }
}

export const createPromptState = () => Ref.make<PendingPrompt | null>(null)

export const beginPendingPrompt = (
  stateRef: Ref.Ref<PendingPrompt | null>,
): Effect.Effect<Deferred.Deferred<PromptResult, unknown>> =>
  Effect.gen(function* () {
    const existing = yield* Ref.get(stateRef)
    if (existing) {
      throw new Error(`Cannot begin prompt: prompt ${existing.userMessageId ?? "<awaiting-user-message>"} is still pending`)
    }

    const deferred = yield* Deferred.make<PromptResult, unknown>()
    yield* Ref.set(stateRef, {
      userMessageId: null,
      deferred,
      assistantsByMessageId: new Map<string, TrackedAssistant>(),
    })
    return deferred
  })

export const failPendingPrompt = (
  stateRef: Ref.Ref<PendingPrompt | null>,
  error: unknown,
): Effect.Effect<void> =>
  Ref.modify(stateRef, (current): readonly [PendingPrompt | null, PendingPrompt | null] => {
    if (!current) {
      return [null, current]
    }

    return [current, null]
  }).pipe(
    Effect.flatMap((current) =>
      current
        ? Deferred.fail(current.deferred, error).pipe(Effect.ignore)
        : Effect.void),
  )

export const handleUserMessageUpdated = (
  stateRef: Ref.Ref<PendingPrompt | null>,
  message: UserMessage,
): Effect.Effect<ReadonlyArray<PromptTrackingAction>> =>
  updatePendingPrompt(stateRef, (current) => {
    if (current.userMessageId && current.userMessageId !== message.id) {
      return current
    }

    return current.userMessageId === message.id
      ? current
      : {
          ...current,
          userMessageId: message.id,
        }
  })

export const handleAssistantMessageUpdated = (
  stateRef: Ref.Ref<PendingPrompt | null>,
  message: AssistantMessage,
): Effect.Effect<ReadonlyArray<PromptTrackingAction>> =>
  updatePendingPrompt(stateRef, (current) => {
    const nextPrompt = clonePrompt(current)
    const assistantsByMessageId = nextPrompt.assistantsByMessageId
    const tracked = cloneTrackedAssistant(assistantsByMessageId.get(message.id))
    tracked.info = message
    assistantsByMessageId.set(message.id, tracked)
    return nextPrompt
  })

export const handleToolPartUpdated = (
  stateRef: Ref.Ref<PendingPrompt | null>,
  part: ToolPart,
): Effect.Effect<ReadonlyArray<PromptTrackingAction>> =>
  updatePendingPrompt(stateRef, (current) => {
    const nextPrompt = clonePrompt(current)
    const assistantsByMessageId = nextPrompt.assistantsByMessageId
    const tracked = cloneTrackedAssistant(assistantsByMessageId.get(part.messageID))
    if (part.state.status === "pending" || part.state.status === "running") {
      tracked.liveToolCallIds.add(part.callID)
    } else {
      tracked.liveToolCallIds.delete(part.callID)
    }
    assistantsByMessageId.set(part.messageID, tracked)
    return nextPrompt
  })
