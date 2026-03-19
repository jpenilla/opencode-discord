import type { IncomingMessage, ServerResponse } from "node:http";
import type { Writable } from "node:stream";

import { Effect } from "effect";

import {
  ToolBridgeResponseError,
  toolBridgeInternalBoundaryError,
  toolBridgeInternalError,
  type ToolBridgeInternalError,
} from "@/tools/bridge/errors.ts";

export const sendJson = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

export const readJsonBody = (request: IncomingMessage) => {
  return Effect.tryPromise({
    try: async () => {
      const bodyChunks: Uint8Array[] = [];
      for await (const chunk of request) {
        bodyChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      return bodyChunks;
    },
    catch: () => new ToolBridgeResponseError({ status: 400, message: "invalid json" }),
  }).pipe(
    Effect.flatMap((chunks) => {
      if (chunks.length === 0) {
        return Effect.void;
      }

      const raw = Buffer.concat(chunks).toString("utf8");
      return Effect.try({
        try: () => JSON.parse(raw),
        catch: () => new ToolBridgeResponseError({ status: 400, message: "invalid json" }),
      });
    }),
  );
};

export const writeWritableChunk = (writable: Writable, chunk: Uint8Array) =>
  Effect.callback<void, ToolBridgeInternalError>((resume) => {
    const onError = (error: Error) => {
      cleanup();
      resume(
        Effect.fail(
          toolBridgeInternalBoundaryError("writing to the bridge response failed", error),
        ),
      );
    };

    const onDrain = () => {
      cleanup();
      resume(Effect.void);
    };

    const onClose = () => {
      cleanup();
      resume(
        Effect.fail(toolBridgeInternalError("writable closed before the pending write completed")),
      );
    };

    const cleanup = () => {
      writable.off("error", onError);
      writable.off("drain", onDrain);
      writable.off("close", onClose);
    };

    writable.on("error", onError);
    writable.on("close", onClose);

    try {
      if (writable.write(chunk)) {
        cleanup();
        resume(Effect.void);
        return Effect.sync(cleanup);
      }
    } catch (error) {
      cleanup();
      resume(
        Effect.fail(
          toolBridgeInternalBoundaryError("writing to the bridge response failed", error),
        ),
      );
      return Effect.sync(cleanup);
    }

    writable.once("drain", onDrain);
    return Effect.sync(cleanup);
  });

export const endWritable = (writable: Writable) =>
  Effect.callback<void, ToolBridgeInternalError>((resume) => {
    const onError = (error: Error) => {
      cleanup();
      resume(
        Effect.fail(toolBridgeInternalBoundaryError("closing the bridge response failed", error)),
      );
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
      resume(
        Effect.fail(toolBridgeInternalBoundaryError("closing the bridge response failed", error)),
      );
    }

    return Effect.sync(cleanup);
  });

export const pipeAsyncIterableToWritable = (
  readable: AsyncIterable<string | Uint8Array>,
  writable: Writable,
) =>
  Effect.suspend(() => {
    const iterator = readable[Symbol.asyncIterator]();
    let closingIterator: Promise<void> | null = null;

    const closeIterator = async () => {
      if (closingIterator) {
        return closingIterator;
      }

      closingIterator = (async () => {
        if (typeof iterator.return === "function") {
          await iterator.return();
        }
      })();
      return closingIterator;
    };

    return Effect.tryPromise({
      try: async () => {
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              return;
            }

            await Effect.runPromise(
              writeWritableChunk(
                writable,
                typeof next.value === "string" ? Buffer.from(next.value) : next.value,
              ),
            );
          }
        } catch (error) {
          await closeIterator().catch(() => undefined);
          throw error;
        }
      },
      catch: (cause) =>
        toolBridgeInternalBoundaryError("streaming the bridge response failed", cause),
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.tryPromise({
          try: closeIterator,
          catch: (cause) =>
            toolBridgeInternalBoundaryError("closing the bridge source iterator failed", cause),
        }).pipe(Effect.ignore),
      ),
    );
  });
