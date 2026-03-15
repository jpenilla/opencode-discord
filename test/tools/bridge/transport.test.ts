import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { Writable } from "node:stream";
import { Effect } from "effect";

import {
  endWritable,
  pipeAsyncIterableToWritable,
  readJsonBody,
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
          Effect.zipRight(endWritable(writable)),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello world");
  });
});
