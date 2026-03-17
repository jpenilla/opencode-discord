import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";

import {
  endWritable,
  pipeAsyncIterableToWritable,
  readJsonBody,
  writeWritableChunk,
} from "@/tools/bridge/transport.ts";
import { unsafeStub } from "../../support/stub.ts";

const makeRequest = (chunks: Array<string | Uint8Array>) =>
  unsafeStub<IncomingMessage>({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  });

describe("readJsonBody", () => {
  test("returns undefined for an empty body", async () => {
    await expect(Effect.runPromise(readJsonBody(makeRequest([])))).resolves.toBeUndefined();
  });

  test("throws a response error for invalid json", async () => {
    await expect(Effect.runPromise(readJsonBody(makeRequest(["{"])))).rejects.toThrow(
      "invalid json",
    );
  });
});

describe("pipeAsyncIterableToWritable", () => {
  test("streams all chunks into the destination writable", async () => {
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    await expect(
      Effect.runPromise(
        pipeAsyncIterableToWritable(makeRequest(["hello ", Buffer.from("world")]), writable).pipe(
          Effect.andThen(endWritable(writable)),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello world");
  });

  test("calls iterator.return() when interrupted", async () => {
    const blockedNext = await Effect.runPromise(
      Deferred.make<IteratorResult<Uint8Array, undefined>>(),
    );
    const nextStarted = await Effect.runPromise(Deferred.make<void>());
    let returnCalled = false;
    const readable = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await Effect.runPromise(Deferred.succeed(nextStarted, undefined).pipe(Effect.ignore));
          return Effect.runPromise(Deferred.await(blockedNext));
        },
        return: async () => {
          returnCalled = true;
          await Effect.runPromise(
            Deferred.succeed(blockedNext, { done: true, value: undefined } as const).pipe(
              Effect.ignore,
            ),
          );
          return { done: true, value: undefined } as const;
        },
      }),
    } satisfies AsyncIterable<Uint8Array>;
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* pipeAsyncIterableToWritable(readable, writable).pipe(Effect.forkChild);
        yield* Deferred.await(nextStarted);
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(returnCalled).toBe(true);
  });
});

describe("writeWritableChunk", () => {
  test("fails promptly when a backpressured writable closes before drain", async () => {
    const writable = new PassThrough();
    const exitPromise = Effect.runPromise(
      writeWritableChunk(writable, Buffer.alloc(1024 * 1024)).pipe(
        Effect.exit,
        Effect.timeoutOrElse({
          duration: "1 second",
          onTimeout: () =>
            Effect.fail(new Error("writeWritableChunk hung after the writable closed")),
        }),
      ),
    );

    setTimeout(() => {
      writable.destroy();
    }, 10);

    const exit = await exitPromise;

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      throw new Error("expected writeWritableChunk to fail");
    }
    expect(Cause.pretty(exit.cause)).toContain(
      "writable closed before the pending write completed",
    );
  });
});
