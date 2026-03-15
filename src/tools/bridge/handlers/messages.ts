import { Effect } from "effect";
import * as v from "valibot";

import { normalizeReactionEmoji } from "@/discord/assets.ts";
import { ToolBridgeResponseError } from "@/tools/bridge/errors.ts";
import { tryBridgePromise } from "@/tools/bridge/handlers/shared.ts";
import type { ToolBridgeHandlerContext } from "@/tools/bridge/routes.ts";
import { getRunMessageById, resolveReactionTargetMessage } from "@/tools/bridge/run-message.ts";
import { nonEmptyString } from "@/tools/bridge/validation.ts";

export const messageRoutePayloadSchema = v.object({
  messageId: nonEmptyString,
});

export type MessageRoutePayload = v.InferOutput<typeof messageRoutePayloadSchema>;

export const reactPayloadSchema = v.object({
  ...messageRoutePayloadSchema.entries,
  emoji: nonEmptyString,
});

export type ReactPayload = v.InferOutput<typeof reactPayloadSchema>;

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

export const handleReact = (context: ToolBridgeHandlerContext<ReactPayload>) => {
  return Effect.gen(function* () {
    const { emoji: emojiInput, messageId } = context.payload;
    const targetMessage = yield* resolveReactionTargetMessage(context.activeRun, messageId);
    if (!targetMessage) {
      return yield* Effect.fail(
        new ToolBridgeResponseError(
          404,
          `messageId is not available in this channel: ${messageId}`,
        ),
      );
    }

    const emoji = normalizeReactionEmoji(targetMessage, emojiInput);
    if (!emoji) {
      return yield* Effect.fail(new ToolBridgeResponseError(400, "invalid or unavailable emoji"));
    }

    yield* tryBridgePromise(() => targetMessage.react(emoji));
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
      return yield* Effect.fail(
        new ToolBridgeResponseError(
          404,
          `messageId is not available in the current run: ${messageId}`,
        ),
      );
    }

    const attachments = [...targetMessage.attachments.values()];
    if (attachments.length === 0) {
      return yield* Effect.fail(
        new ToolBridgeResponseError(409, `no attachments on Discord message ${messageId}`),
      );
    }

    return JSON.stringify(
      {
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
      },
      null,
      2,
    );
  });
};
