import { describe, expect, test } from "bun:test";
import type { Client, Message } from "discord.js";

import { detectInvocation } from "@/discord/triggers.ts";
import { unsafeStub } from "../support/stub.ts";

const makeClient = (botId = "bot-1") =>
  unsafeStub<Client>({
    user: { id: botId },
  });

const makeMessage = (input?: { content?: string; authorId?: string; authorBot?: boolean }) =>
  unsafeStub<Message>({
    content: input?.content ?? "",
    author: {
      id: input?.authorId ?? "user-1",
      bot: input?.authorBot ?? false,
    },
    reference: null,
    mentions: {
      repliedUser: null,
    },
    fetchReference: async () => {
      throw new Error("fetchReference should not be called");
    },
  });

describe("detectInvocation", () => {
  test("allows other bot mentions when ignoreOtherBotTriggers is false", async () => {
    await expect(
      detectInvocation({
        client: makeClient(),
        message: makeMessage({
          content: "<@bot-1> summarize this",
          authorId: "bot-2",
          authorBot: true,
        }),
        triggerPhrase: "hey opencode",
        ignoreOtherBotTriggers: false,
      }),
    ).resolves.toEqual({
      prompt: "summarize this",
    });
  });

  test("ignores other bot messages when ignoreOtherBotTriggers is true", async () => {
    await expect(
      detectInvocation({
        client: makeClient(),
        message: makeMessage({
          content: "<@bot-1> summarize this",
          authorId: "bot-2",
          authorBot: true,
        }),
        triggerPhrase: "hey opencode",
        ignoreOtherBotTriggers: true,
      }),
    ).resolves.toBeNull();
  });

  test("always ignores this bot's own messages", async () => {
    await expect(
      detectInvocation({
        client: makeClient(),
        message: makeMessage({
          content: "<@bot-1> summarize this",
          authorId: "bot-1",
          authorBot: true,
        }),
        triggerPhrase: "hey opencode",
        ignoreOtherBotTriggers: false,
      }),
    ).resolves.toBeNull();
  });
});
