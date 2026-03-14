import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { Effect } from "effect";

import { readJsonBody } from "@/tools/bridge/transport.ts";
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
