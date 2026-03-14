import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as v from "valibot";

import {
  nonEmptyString,
  parseBridgePayload,
  parseSessionPayload,
} from "@/tools/bridge/validation.ts";

describe("parseSessionPayload", () => {
  test("throws when sessionID is missing or blank", async () => {
    await expect(Effect.runPromise(parseSessionPayload({}))).rejects.toThrow("missing sessionID");
    await expect(Effect.runPromise(parseSessionPayload({ sessionID: "" }))).rejects.toThrow(
      "missing sessionID",
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
  test("throws the provided error when validation fails", async () => {
    const schema = v.object({
      sessionID: nonEmptyString,
      messageId: nonEmptyString,
    });

    await expect(
      Effect.runPromise(
        parseBridgePayload(schema, { sessionID: "session-1" }, "missing messageId"),
      ),
    ).rejects.toThrow("missing messageId");
  });

  test("returns typed output when validation succeeds", async () => {
    const schema = v.object({
      sessionID: nonEmptyString,
      messageId: nonEmptyString,
    });

    await expect(
      Effect.runPromise(
        parseBridgePayload(
          schema,
          { sessionID: "session-1", messageId: "m-1", extra: true },
          "bad",
        ),
      ),
    ).resolves.toEqual({
      sessionID: "session-1",
      messageId: "m-1",
    });
  });
});
