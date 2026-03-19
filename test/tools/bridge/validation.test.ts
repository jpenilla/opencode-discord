import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import {
  nonEmptyString,
  parseBridgePayload,
  parseSessionPayload,
} from "@/tools/bridge/validation.ts";

describe("parseSessionPayload", () => {
  test("reports a missing sessionID", async () => {
    return expect(Effect.runPromise(parseSessionPayload({}))).rejects.toThrow(
      'invalid request\nMissing key\n  at ["sessionID"]',
    );
  });

  test("reports a blank sessionID", async () => {
    return expect(Effect.runPromise(parseSessionPayload({ sessionID: "" }))).rejects.toThrow(
      'invalid request\nExpected a value with a length of at least 1, got ""\n  at ["sessionID"]',
    );
  });

  test("rejects unexpected keys on session-only payloads", async () => {
    return expect(
      Effect.runPromise(parseSessionPayload({ sessionID: "session-1", messageId: "m-1" })),
    ).rejects.toThrow('invalid request\nUnexpected key with value "m-1"\n  at ["messageId"]');
  });
});

describe("parseBridgePayload", () => {
  test("reports validation failures from Effect Schema", async () => {
    const schema = Schema.Struct({
      sessionID: nonEmptyString,
      messageId: nonEmptyString,
    });

    return expect(
      Effect.runPromise(parseBridgePayload(schema, { sessionID: "session-1" })),
    ).rejects.toThrow('invalid request\nMissing key\n  at ["messageId"]');
  });

  test("includes multiple issue paths when validation fails in more than one place", async () => {
    const schema = Schema.Struct({
      sessionID: nonEmptyString,
      messageId: nonEmptyString,
    });

    return expect(Effect.runPromise(parseBridgePayload(schema, { sessionID: "" }))).rejects.toThrow(
      'invalid request\nExpected a value with a length of at least 1, got ""\n  at ["sessionID"]\nMissing key\n  at ["messageId"]',
    );
  });

  test("returns typed output when validation succeeds", async () => {
    const schema = Schema.Struct({
      sessionID: nonEmptyString,
      messageId: nonEmptyString,
    });

    return expect(
      Effect.runPromise(parseBridgePayload(schema, { sessionID: "session-1", messageId: "m-1" })),
    ).resolves.toEqual({
      sessionID: "session-1",
      messageId: "m-1",
    });
  });

  test("rejects unexpected keys", async () => {
    const schema = Schema.Struct({
      sessionID: nonEmptyString,
      messageId: nonEmptyString,
    });

    return expect(
      Effect.runPromise(
        parseBridgePayload(schema, { sessionID: "session-1", messageId: "m-1", extra: true }),
      ),
    ).rejects.toThrow('invalid request\nUnexpected key with value true\n  at ["extra"]');
  });
});
