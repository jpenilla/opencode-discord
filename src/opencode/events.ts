import type {
  Event,
  EventMessagePartUpdated,
  EventMessageUpdated,
  PatchPart,
  EventPermissionReplied,
  EventSessionStatus,
  GlobalEvent,
  PermissionRequest,
  TextPart,
  ToolPart,
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

export const getAssistantMessageUpdated = (event: Event): EventMessageUpdated | null => {
  if (event.type !== "message.updated" || event.properties.info.role !== "assistant") {
    return null
  }
  return event
}

export const getToolPartUpdated = (event: Event): ToolPart | null => {
  if (event.type !== "message.part.updated") {
    return null
  }
  return event.properties.part.type === "tool" ? event.properties.part : null
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

export const getMessagePartUpdated = (event: Event): EventMessagePartUpdated | null => {
  if (event.type !== "message.part.updated") {
    return null
  }
  return event
}

export const getPatchPart = (event: Event): PatchPart | null => {
  const partUpdated = getMessagePartUpdated(event)
  if (!partUpdated || partUpdated.properties.part.type !== "patch") {
    return null
  }
  return partUpdated.properties.part
}

export const getTextPart = (event: Event): TextPart | null => {
  const partUpdated = getMessagePartUpdated(event)
  if (!partUpdated || partUpdated.properties.part.type !== "text") {
    return null
  }
  return partUpdated.properties.part
}
