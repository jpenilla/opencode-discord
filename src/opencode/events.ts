import type {
  AssistantMessage,
  Event,
  GlobalEvent,
} from "@opencode-ai/sdk/v2";
import { Layer, Queue, ServiceMap } from "effect";

export class OpencodeEventQueue extends ServiceMap.Service<
  OpencodeEventQueue,
  Queue.Queue<GlobalEvent>
>()("OpencodeEventQueue") {}

export const OpencodeEventQueueLayer = Layer.effect(
  OpencodeEventQueue,
  Queue.unbounded<GlobalEvent>(),
);

type EventOfType<TType extends Event["type"]> = Extract<Event, { type: TType }>;
type MessageInfo = EventOfType<"message.updated">["properties"]["info"];
type UpdatedMessagePart = EventOfType<"message.part.updated">["properties"]["part"];
type EventPropertiesWithSessionId = { sessionID?: unknown };

export const getEventByType = <TType extends Event["type"]>(
  event: Event,
  type: TType,
): EventOfType<TType> | null => {
  if (event.type !== type) {
    return null;
  }

  return event as EventOfType<TType>;
};

export const getMessageUpdatedByRole = <TRole extends MessageInfo["role"]>(
  event: Event,
  role: TRole,
): Extract<MessageInfo, { role: TRole }> | null => {
  const info = getEventByType(event, "message.updated")?.properties.info;
  return info?.role === role ? (info as Extract<MessageInfo, { role: TRole }>) : null;
};

export const getUpdatedPartByType = <TType extends UpdatedMessagePart["type"]>(
  event: Event,
  type: TType,
): Extract<UpdatedMessagePart, { type: TType }> | null => {
  const part = getEventByType(event, "message.part.updated")?.properties.part;
  return part?.type === type ? (part as Extract<UpdatedMessagePart, { type: TType }>) : null;
};

const getSessionIdFromProperties = (properties: EventPropertiesWithSessionId) =>
  typeof properties.sessionID === "string" ? properties.sessionID : null;

export const getEventSessionId = (event: Event) =>
  event.type === "message.updated"
    ? event.properties.info.sessionID
    : event.type === "message.part.updated"
      ? event.properties.part.sessionID
      : getSessionIdFromProperties(event.properties as EventPropertiesWithSessionId);

export const isCompactionSummaryAssistant = (message: AssistantMessage) =>
  message.summary === true && message.mode === "compaction" && message.agent === "compaction";

export const isObservedAssistantMessage = (message: AssistantMessage) =>
  message.time.completed !== undefined ||
  message.finish !== undefined ||
  message.error !== undefined;
