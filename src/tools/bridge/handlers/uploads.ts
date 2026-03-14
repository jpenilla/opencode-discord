import { AttachmentBuilder } from "discord.js";
import { Effect } from "effect";
import * as v from "valibot";

import { requireSendableChannel, sendBridgeMessage } from "@/tools/bridge/handlers/shared.ts";
import type { ToolBridgeHandlerContext } from "@/tools/bridge/routes.ts";
import { nonEmptyString } from "@/tools/bridge/validation.ts";

export const uploadPayloadSchema = v.object({
  filename: nonEmptyString,
  dataBase64: v.string(),
  caption: v.optional(v.string()),
  displayPath: v.optional(v.string()),
});

export type UploadPayload = v.InferOutput<typeof uploadPayloadSchema>;

const handleUpload = (context: ToolBridgeHandlerContext<UploadPayload>, kind: "file" | "image") => {
  return Effect.gen(function* () {
    const { caption, dataBase64, displayPath, filename } = context.payload;
    const channel = yield* requireSendableChannel(context.activeRun);
    const attachment = new AttachmentBuilder(Buffer.from(dataBase64, "base64"), {
      name: filename,
    });

    yield* sendBridgeMessage(channel, {
      content: caption,
      files: [attachment],
    });

    return `Sent ${kind} ${displayPath ?? filename}`;
  });
};

export const handleSendFile = (context: ToolBridgeHandlerContext<UploadPayload>) => {
  return handleUpload(context, "file");
};

export const handleSendImage = (context: ToolBridgeHandlerContext<UploadPayload>) => {
  return handleUpload(context, "image");
};
