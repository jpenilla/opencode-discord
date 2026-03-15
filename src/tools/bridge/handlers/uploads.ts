import type { IncomingHttpHeaders } from "node:http";
import { PassThrough } from "node:stream";

import { AttachmentBuilder } from "discord.js";
import { Effect } from "effect";
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

const destroyStream = (stream: { destroyed?: boolean; destroy: (error?: Error) => void }) => {
  if (!stream.destroyed) {
    stream.destroy();
  }
};

const stopReadingRequestBody = (
  request: Pick<ToolBridgeHandlerContext<UploadPayload>["request"], "pause" | "unpipe">,
) =>
  Effect.sync(() => {
    request.unpipe();
    request.pause();
  });

export const cleanupFailedUpload = (
  request: Pick<ToolBridgeHandlerContext<UploadPayload>["request"], "pause" | "unpipe">,
  uploadStream: {
    destroyed?: boolean;
    destroy: (error?: Error) => void;
  },
) =>
  Effect.all(
    [
      stopReadingRequestBody(request),
      Effect.sync(() => {
        // The bridge already reports the primary failure. Tear down the outgoing upload stream
        // without re-emitting that same failure as a second stream error.
        destroyStream(uploadStream);
      }),
    ],
    { discard: true },
  );

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
    ).pipe(Effect.onError(() => cleanupFailedUpload(context.request, uploadStream)));

    return `Sent ${kind} ${displayPath ?? filename}`;
  });
};

export const handleSendFile = (context: ToolBridgeHandlerContext<UploadPayload>) => {
  return handleUpload(context, "file");
};

export const handleSendImage = (context: ToolBridgeHandlerContext<UploadPayload>) => {
  return handleUpload(context, "image");
};
