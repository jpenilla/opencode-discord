import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as v from "valibot";

import {
  nonEmptyString,
  parseBridgePayload,
  parseSessionPayload,
} from "@/tools/bridge/validation.ts";

describe("parseSessionPayload", () => {
  test("formats missing sessionID from the valibot result", async () => {
    await expect(Effect.runPromise(parseSessionPayload({}))).rejects.toThrow(
      'invalid request: sessionID: Invalid key: Expected "sessionID" but received undefined',
    );
  });

  test("formats blank sessionID from the valibot result", async () => {
    await expect(Effect.runPromise(parseSessionPayload({ sessionID: "" }))).rejects.toThrow(
      "invalid request: sessionID: Invalid length: Expected >=1 but received 0",
    );
  });

  test("returns the payload when sessionID is present and preserves extras", async () => {
    await expect(
      Effect.runPromise(parseSessionPayload({ sessionID: "session-1", messageId: "m-1" })),
    ).resolves.toEqual({
      sessionID: "session-1",
      messageId: "m-1",
    });
  });
});

describe("parseBridgePayload", () => {
  test("formats validation failures from valibot issues", async () => {
    const schema = v.object({
      sessionID: nonEmptyString,
      messageId: nonEmptyString,
    });

    await expect(
      Effect.runPromise(parseBridgePayload(schema, { sessionID: "session-1" })),
    ).rejects.toThrow(
      'invalid request: messageId: Invalid key: Expected "messageId" but received undefined',
    );
  });

  test("includes multiple issue paths when validation fails in more than one place", async () => {
    const schema = v.object({
      sessionID: nonEmptyString,
      messageId: nonEmptyString,
    });

    await expect(Effect.runPromise(parseBridgePayload(schema, { sessionID: "" }))).rejects.toThrow(
      'invalid request: sessionID: Invalid length: Expected >=1 but received 0; messageId: Invalid key: Expected "messageId" but received undefined',
    );
  });

  test("returns typed output when validation succeeds", async () => {
    const schema = v.object({
      sessionID: nonEmptyString,
      messageId: nonEmptyString,
    });

    await expect(
      Effect.runPromise(
        parseBridgePayload(schema, { sessionID: "session-1", messageId: "m-1", extra: true }),
      ),
    ).resolves.toEqual({
      sessionID: "session-1",
      messageId: "m-1",
    });
  });
});
