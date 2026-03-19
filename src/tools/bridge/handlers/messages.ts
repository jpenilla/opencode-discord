import { Effect, Schema, SchemaGetter } from "effect";

import { normalizeReactionEmoji } from "@/discord/assets.ts";
import { ToolBridgeResponseError } from "@/tools/bridge/errors.ts";
import { tryBridgePromise } from "@/tools/bridge/handlers/shared.ts";
import type { ToolBridgeHandlerContext } from "@/tools/bridge/routes.ts";
import { getRunMessageById, resolveReactionTargetMessage } from "@/tools/bridge/run-message.ts";
import { nonEmptyString } from "@/tools/bridge/validation.ts";

export const messageRoutePayloadSchema = Schema.Struct({
  messageId: nonEmptyString,
});

export type MessageRoutePayload = Schema.Schema.Type<typeof messageRoutePayloadSchema>;

export const reactPayloadSchema = Schema.Struct({
  ...messageRoutePayloadSchema.fields,
  emoji: nonEmptyString,
});

export type ReactPayload = Schema.Schema.Type<typeof reactPayloadSchema>;

export const listAttachmentsPayloadSchema = messageRoutePayloadSchema;

export type ListAttachmentsPayload = MessageRoutePayload;

export type AttachmentSummary = {
  attachmentId: string;
  name: string;
  contentType: string | null;
  size: number;
  url: string;
};

export const formatAttachmentList = (attachments: AttachmentSummary[]) => {
  return attachments.map((attachment) => {
    return {
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      size: attachment.size,
      type: attachment.contentType ?? "unknown",
      url: attachment.url,
    };
  });
};

const prettyJsonStringSchema = Schema.String.pipe(
  Schema.decodeTo(Schema.Json, {
    decode: SchemaGetter.parseJson(),
    encode: SchemaGetter.stringifyJson({ space: 2 }),
  }),
);

export const handleReact = (context: ToolBridgeHandlerContext<ReactPayload>) => {
  return Effect.gen(function* () {
    const { emoji: emojiInput, messageId } = context.payload;
    const targetMessage = yield* resolveReactionTargetMessage(context.activeRun, messageId);
    if (!targetMessage) {
      return yield* new ToolBridgeResponseError({
        status: 404,
        message: `messageId is not available in this channel: ${messageId}`,
      });
    }

    const emoji = normalizeReactionEmoji(targetMessage, emojiInput);
    if (!emoji) {
      return yield* new ToolBridgeResponseError({
        status: 400,
        message: "invalid or unavailable emoji",
      });
    }

    yield* tryBridgePromise("adding a Discord reaction failed", () => targetMessage.react(emoji));
    return `Added reaction ${emoji} to Discord message ${targetMessage.id}`;
  });
};

export const handleListAttachments = (
  context: ToolBridgeHandlerContext<ListAttachmentsPayload>,
) => {
  return Effect.gen(function* () {
    const { messageId } = context.payload;
    const targetMessage = getRunMessageById(context.activeRun, messageId);
    if (!targetMessage) {
      return yield* new ToolBridgeResponseError({
        status: 404,
        message: `messageId is not available in the current run: ${messageId}`,
      });
    }

    const attachments = [...targetMessage.attachments.values()];
    if (attachments.length === 0) {
      return yield* new ToolBridgeResponseError({
        status: 409,
        message: `no attachments on Discord message ${messageId}`,
      });
    }

    return yield* Schema.encodeUnknownEffect(prettyJsonStringSchema)({
      description: `Attachments on Discord message ${messageId}`,
      list: formatAttachmentList(
        attachments.map((attachment) => ({
          attachmentId: attachment.id,
          name: attachment.name ?? attachment.id,
          contentType: attachment.contentType,
          size: attachment.size,
          url: attachment.url,
        })),
      ),
    });
  });
};
