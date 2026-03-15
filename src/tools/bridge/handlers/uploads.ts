import type { IncomingHttpHeaders } from "node:http";
import { PassThrough } from "node:stream";

import { AttachmentBuilder } from "discord.js";
import { Cause, Effect } from "effect";
import * as v from "valibot";

import { requireSendableChannel, sendBridgeMessage } from "@/tools/bridge/handlers/shared.ts";
import type { ToolBridgeHandlerContext } from "@/tools/bridge/routes.ts";
import { endWritable, pipeAsyncIterableToWritable } from "@/tools/bridge/transport.ts";
import { nonEmptyString, parseEncodedBridgePayload } from "@/tools/bridge/validation.ts";

export const uploadPayloadSchema = v.object({
  sessionID: nonEmptyString,
  filename: nonEmptyString,
  caption: v.optional(v.string()),
  displayPath: v.optional(v.string()),
});

export type UploadPayload = v.InferOutput<typeof uploadPayloadSchema>;
export const uploadMetadataHeader = "x-opencode-discord-upload";

export const parseUploadHeaders = (headers: IncomingHttpHeaders) =>
  parseEncodedBridgePayload(uploadPayloadSchema, headers[uploadMetadataHeader], {
    missingError: "missing upload metadata",
    invalidError: "invalid upload metadata",
  });

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const destroyStream = (
  stream: {
    destroyed?: boolean;
    destroy: (error?: Error) => void;
  },
  error: unknown,
) => {
  if (!stream.destroyed) {
    stream.destroy(toError(error));
  }
};

export const cleanupFailedUpload = (
  uploadStream: {
    destroyed?: boolean;
    destroy: (error?: Error) => void;
  },
  error: unknown,
) =>
  Effect.sync(() => {
    destroyStream(uploadStream, error);
  });

const handleUpload = (context: ToolBridgeHandlerContext<UploadPayload>, kind: "file" | "image") => {
  return Effect.gen(function* () {
    const { caption, displayPath, filename } = context.payload;
    const channel = yield* requireSendableChannel(context.activeRun);
    const uploadStream = new PassThrough();
    const attachment = new AttachmentBuilder(uploadStream, { name: filename });

    yield* Effect.all(
      [
        sendBridgeMessage(channel, {
          content: caption,
          files: [attachment],
        }),
        pipeAsyncIterableToWritable(context.request, uploadStream).pipe(
          Effect.tap(() => endWritable(uploadStream)),
        ),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.onError((cause) => cleanupFailedUpload(uploadStream, Cause.squash(cause))));

    return `Sent ${kind} ${displayPath ?? filename}`;
  });
};

export const handleSendFile = (context: ToolBridgeHandlerContext<UploadPayload>) => {
  return handleUpload(context, "file");
};

export const handleSendImage = (context: ToolBridgeHandlerContext<UploadPayload>) => {
  return handleUpload(context, "image");
};
