import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { collectAttachmentMessages, resolveReferencedMessage } from "@/sessions/message-context.ts";
import { makeMessage } from "../support/fixtures.ts";

describe("resolveReferencedMessage", () => {
  test("returns null when the message is not a reply", async () => {
    let called = false;
    const message = makeMessage({
      id: "m-1",
      fetchReference: async () => {
        called = true;
        throw new Error("should not run");
      },
    });

    const result = await Effect.runPromise(resolveReferencedMessage(message));
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  test("returns the fetched referenced message when available", async () => {
    const referenced = makeMessage({ id: "m-2" });
    const message = makeMessage({
      id: "m-1",
      reference: { messageId: "m-2" },
      fetchReference: async () => referenced,
    });

    const result = await Effect.runPromise(resolveReferencedMessage(message));
    expect(result).toBe(referenced);
  });

  test("degrades fetchReference failures to null", async () => {
    const message = makeMessage({
      id: "m-1",
      reference: { messageId: "m-2" },
      fetchReference: async () => {
        throw new Error("boom");
      },
    });

    const result = await Effect.runPromise(resolveReferencedMessage(message));
    expect(result).toBeNull();
  });
});

describe("collectAttachmentMessages", () => {
  test("includes the current and referenced messages", async () => {
    const referenced = makeMessage({ id: "m-2", attachmentCount: 0 });
    const message = makeMessage({
      id: "m-1",
      reference: { messageId: "m-2" },
      fetchReference: async () => referenced,
      attachmentCount: 1,
    });

    const result = await Effect.runPromise(collectAttachmentMessages(message));
    expect(result.map((entry) => entry.id)).toEqual(["m-1", "m-2"]);
    expect(result[1]?.attachments.size).toBe(0);
  });

  test("dedupes when the referenced message resolves to the same id", async () => {
    const self = makeMessage({ id: "m-1" });
    const message = makeMessage({
      id: "m-1",
      reference: { messageId: "m-1" },
      fetchReference: async () => self,
    });

    const result = await Effect.runPromise(collectAttachmentMessages(message));
    expect(result.map((entry) => entry.id)).toEqual(["m-1"]);
  });
});
