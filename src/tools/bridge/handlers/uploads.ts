import type { IncomingHttpHeaders } from "node:http";
import { PassThrough } from "node:stream";

import { AttachmentBuilder } from "discord.js";
import { Effect, Fiber } from "effect";
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
type UploadRequest = Partial<
  Pick<ToolBridgeHandlerContext<UploadPayload>["request"], "pause" | "resume" | "unpipe">
> & { destroyed?: boolean };
type UploadStream = {
  destroyed?: boolean;
  destroy: (error?: Error) => void;
};
type UploadWritable = PassThrough;

export const parseUploadHeaders = (headers: IncomingHttpHeaders) =>
  parseEncodedBridgePayload(uploadPayloadSchema, headers[uploadMetadataHeader], {
    missingError: "missing upload metadata",
    invalidError: "invalid upload metadata",
  });

const destroyStream = (stream: UploadStream, error?: Error) => {
  if (!stream.destroyed) {
    stream.destroy(error);
  }
};

const stopReadingRequestBody = (request: UploadRequest) =>
  Effect.sync(() => {
    request.unpipe?.();
    if (request.destroyed) {
      return;
    }

    if (typeof request.resume === "function") {
      request.resume();
      return;
    }

    request.pause?.();
  });

export const cleanupFailedUpload = (request: UploadRequest, uploadStream: UploadStream) =>
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

const startUploadFiber = (
  request: ToolBridgeHandlerContext<UploadPayload>["request"],
  uploadStream: UploadWritable,
) =>
  pipeAsyncIterableToWritable(request, uploadStream).pipe(
    Effect.andThen(endWritable(uploadStream)),
    Effect.tapError((error) =>
      Effect.sync(() => {
        destroyStream(uploadStream, error);
      }),
    ),
    Effect.forkChild({ startImmediately: true }),
  );

const failUpload = <E>(request: UploadRequest, uploadStream: UploadStream, error: E) =>
  cleanupFailedUpload(request, uploadStream).pipe(Effect.andThen(Effect.fail<E>(error)));

const handleUpload = (context: ToolBridgeHandlerContext<UploadPayload>, kind: "file" | "image") => {
  return Effect.gen(function* () {
    const { caption, displayPath, filename } = context.payload;
    const channel = yield* requireSendableChannel(context.activeRun);
    const uploadStream = new PassThrough();
    const attachment = new AttachmentBuilder(uploadStream, { name: filename });
    const uploadFiber = yield* startUploadFiber(context.request, uploadStream);

    const sendResult = yield* sendBridgeMessage(channel, {
      content: caption,
      files: [attachment],
    }).pipe(Effect.result);
    if (sendResult._tag === "Failure") {
      return yield* failUpload(context.request, uploadStream, sendResult.failure);
    }

    yield* Fiber.join(uploadFiber).pipe(
      Effect.catch((error) => failUpload(context.request, uploadStream, error)),
    );

    return `Sent ${kind} ${displayPath ?? filename}`;
  });
};

export const handleSendFile = (context: ToolBridgeHandlerContext<UploadPayload>) => {
  return handleUpload(context, "file");
};

export const handleSendImage = (context: ToolBridgeHandlerContext<UploadPayload>) => {
  return handleUpload(context, "image");
};
