import type {
  AssistantMessage,
  CompactionPart,
  Event,
  EventQuestionReplied,
  EventQuestionRejected,
  EventSessionCompacted,
  EventSessionError,
  EventSessionIdle,
  PatchPart,
  QuestionRequest,
  ReasoningPart,
  EventPermissionReplied,
  EventSessionStatus,
  GlobalEvent,
  PermissionRequest,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { Context, Effect, Layer, Queue } from "effect"

export type OpencodeEventQueueShape = {
  publish: (event: GlobalEvent) => Effect.Effect<void>
  take: () => Effect.Effect<GlobalEvent>
}

export class OpencodeEventQueue extends Context.Tag("OpencodeEventQueue")<OpencodeEventQueue, OpencodeEventQueueShape>() {}

export const OpencodeEventQueueLive = Layer.effect(
  OpencodeEventQueue,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<GlobalEvent>()

    return {
      publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
      take: () => Queue.take(queue),
    } satisfies OpencodeEventQueueShape
  }),
)

export const getEventSessionId = (event: Event) => {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID
    case "message.part.updated":
      return event.properties.part.sessionID
    case "message.part.delta":
      return event.properties.sessionID
    case "message.part.removed":
    case "permission.asked":
    case "permission.replied":
    case "session.status":
    case "session.idle":
    case "session.compacted":
    case "session.error":
    case "session.diff":
    case "message.removed":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      return event.properties.sessionID
    default:
      return null
  }
}

export const getToolPartUpdated = (event: Event): ToolPart | null => {
  if (event.type !== "message.part.updated") {
    return null
  }
  return event.properties.part.type === "tool" ? event.properties.part : null
}

export const getAssistantMessageUpdated = (event: Event): AssistantMessage | null => {
  if (event.type !== "message.updated") {
    return null
  }
  return event.properties.info.role === "assistant" ? event.properties.info : null
}

export const isCompactionSummaryAssistant = (message: AssistantMessage) =>
  message.summary === true &&
  message.mode === "compaction" &&
  message.agent === "compaction"

export const isObservedAssistantMessage = (message: AssistantMessage) =>
  message.time.completed !== undefined || message.finish !== undefined || message.error !== undefined

export const getUserMessageUpdated = (event: Event): UserMessage | null => {
  if (event.type !== "message.updated") {
    return null
  }
  return event.properties.info.role === "user" ? event.properties.info : null
}

export const getPermissionUpdated = (event: Event): PermissionRequest | null => {
  if (event.type !== "permission.asked") {
    return null
  }
  return event.properties
}

export const getPermissionReplied = (event: Event): EventPermissionReplied["properties"] | null => {
  if (event.type !== "permission.replied") {
    return null
  }
  return event.properties
}

export const getSessionStatusUpdated = (event: Event): EventSessionStatus["properties"] | null => {
  if (event.type !== "session.status") {
    return null
  }
  return event.properties
}

export const getSessionIdle = (event: Event): EventSessionIdle["properties"] | null => {
  if (event.type !== "session.idle") {
    return null
  }
  return event.properties
}

export const getSessionError = (event: Event): EventSessionError["properties"] | null => {
  if (event.type !== "session.error") {
    return null
  }
  return event.properties
}

export const getSessionCompacted = (event: Event): EventSessionCompacted["properties"] | null => {
  if (event.type !== "session.compacted") {
    return null
  }
  return event.properties
}

export const getCompactionPart = (event: Event): CompactionPart | null => {
  if (event.type !== "message.part.updated" || event.properties.part.type !== "compaction") {
    return null
  }
  return event.properties.part
}

export const getPatchPart = (event: Event): PatchPart | null => {
  if (event.type !== "message.part.updated" || event.properties.part.type !== "patch") {
    return null
  }
  return event.properties.part
}

export const getReasoningPart = (event: Event): ReasoningPart | null => {
  if (event.type !== "message.part.updated" || event.properties.part.type !== "reasoning") {
    return null
  }
  return event.properties.part
}

export const getQuestionAsked = (event: Event): QuestionRequest | null => {
  if (event.type !== "question.asked") {
    return null
  }
  return event.properties
}

export const getQuestionReplied = (event: Event): EventQuestionReplied["properties"] | null => {
  if (event.type !== "question.replied") {
    return null
  }
  return event.properties
}

export const getQuestionRejected = (event: Event): EventQuestionRejected["properties"] | null => {
  if (event.type !== "question.rejected") {
    return null
  }
  return event.properties
}
