import { describe, expect, test } from "bun:test";
import type { Message } from "discord.js";
import { Effect } from "effect";

import { getRunMessageById, resolveReactionTargetMessage } from "@/tools/run-message.ts";
import { unsafeStub } from "../support/stub.ts";

const makeMessage = (id: string, overrides: Record<string, unknown> = {}) =>
  unsafeStub<Message>({ id, ...overrides });

describe("getRunMessageById", () => {
  test("returns the primary Discord message when its id is requested", () => {
    const primary = makeMessage("m-1");

    expect(
      getRunMessageById(
        {
          discordMessage: primary,
          attachmentMessagesById: new Map(),
        },
        "m-1",
      ),
    ).toBe(primary);
  });

  test("returns a tracked run message when it is available by id", () => {
    const primary = makeMessage("m-1");
    const referenced = makeMessage("m-2");

    expect(
      getRunMessageById(
        {
          discordMessage: primary,
          attachmentMessagesById: new Map([["m-2", referenced]]),
        },
        "m-2",
      ),
    ).toBe(referenced);
  });

  test("returns null when the message id is not available in the current run", () => {
    expect(
      getRunMessageById(
        {
          discordMessage: makeMessage("m-1"),
          attachmentMessagesById: new Map([["m-2", makeMessage("m-2")]]),
        },
        "m-3",
      ),
    ).toBeNull();
  });
});

describe("resolveReactionTargetMessage", () => {
  test("returns a known run message without fetching from the channel", async () => {
    const primary = makeMessage("m-1", {
      channel: {
        messages: {
          fetch: async () => {
            throw new Error("should not fetch");
          },
        },
      },
    });
    const referenced = makeMessage("m-2");

    const result = await Effect.runPromise(
      resolveReactionTargetMessage(
        {
          discordMessage: primary,
          attachmentMessagesById: new Map([["m-2", referenced]]),
        },
        "m-2",
      ),
    );

    expect(result).toBe(referenced);
  });

  test("falls back to fetching the message from the current channel", async () => {
    const fetched = makeMessage("m-9");
    const primary = makeMessage("m-1", {
      channel: {
        messages: {
          fetch: async (messageId: string) => {
            expect(messageId).toBe("m-9");
            return fetched;
          },
        },
      },
    });

    const result = await Effect.runPromise(
      resolveReactionTargetMessage(
        {
          discordMessage: primary,
          attachmentMessagesById: new Map(),
        },
        "m-9",
      ),
    );

    expect(result).toBe(fetched);
  });

  test("returns null when the current channel cannot resolve the message id", async () => {
    const primary = makeMessage("m-1", {
      channel: {
        messages: {
          fetch: async () => {
            throw new Error("not found");
          },
        },
      },
    });

    const result = await Effect.runPromise(
      resolveReactionTargetMessage(
        {
          discordMessage: primary,
          attachmentMessagesById: new Map(),
        },
        "missing",
      ),
    );

    expect(result).toBeNull();
  });
});
