import type { IncomingMessage, ServerResponse } from "node:http";
import type { Writable } from "node:stream";

import { Effect, Stream } from "effect";

import { ToolBridgeResponseError } from "@/tools/bridge/errors.ts";

export const sendJson = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const readBodyChunks = async (request: IncomingMessage) => {
  const bodyChunks: Uint8Array[] = [];
  for await (const chunk of request) {
    bodyChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return bodyChunks;
};

export const readJsonBody = (request: IncomingMessage) => {
  return Effect.tryPromise({
    try: () => readBodyChunks(request),
    catch: () => new ToolBridgeResponseError(400, "invalid json"),
  }).pipe(
    Effect.flatMap((chunks) => {
      if (chunks.length === 0) {
        return Effect.succeed(undefined);
      }

      const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
      return Effect.try({
        try: () => JSON.parse(raw),
        catch: () => new ToolBridgeResponseError(400, "invalid json"),
      });
    }),
  );
};

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const normalizeChunk = (chunk: string | Uint8Array) =>
  typeof chunk === "string" ? Buffer.from(chunk) : chunk;

export const writeWritableChunk = (writable: Writable, chunk: Uint8Array) =>
  Effect.async<void, Error>((resume) => {
    const onError = (error: Error) => {
      cleanup();
      resume(Effect.fail(error));
    };

    const onDrain = () => {
      cleanup();
      resume(Effect.void);
    };

    const cleanup = () => {
      writable.off("error", onError);
      writable.off("drain", onDrain);
    };

    writable.on("error", onError);

    try {
      if (writable.write(chunk)) {
        cleanup();
        resume(Effect.void);
        return Effect.sync(cleanup);
      }
    } catch (error) {
      cleanup();
      resume(Effect.fail(toError(error)));
      return Effect.sync(cleanup);
    }

    writable.once("drain", onDrain);
    return Effect.sync(cleanup);
  });

export const endWritable = (writable: Writable) =>
  Effect.async<void, Error>((resume) => {
    const onError = (error: Error) => {
      cleanup();
      resume(Effect.fail(error));
    };

    const cleanup = () => {
      writable.off("error", onError);
    };

    writable.once("error", onError);

    try {
      writable.end(() => {
        cleanup();
        resume(Effect.void);
      });
    } catch (error) {
      cleanup();
      resume(Effect.fail(toError(error)));
    }

    return Effect.sync(cleanup);
  });

export const pipeAsyncIterableToWritable = (
  readable: AsyncIterable<string | Uint8Array>,
  writable: Writable,
) =>
  Stream.fromAsyncIterable(readable, toError).pipe(
    Stream.runForEach((chunk) => writeWritableChunk(writable, normalizeChunk(chunk))),
  );
