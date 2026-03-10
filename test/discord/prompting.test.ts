import { describe, expect, test } from "bun:test";
import { ChannelType, type Message } from "discord.js";

import {
  buildBatchedOpencodePrompt,
  buildOpencodePrompt,
  buildQueuedFollowUpPrompt,
  promptMessageContext,
  summarizeEmbeds,
} from "@/discord/messages.ts";
import { buildSessionSystemAppend } from "@/discord/system-context.ts";
import { unsafeStub } from "../support/stub.ts";

type EmbedStub = {
  title?: string;
  description?: string;
  url?: string;
  fields?: Array<{ name: string; value: string }>;
};

const baseMessageFields = () => ({
  id: "m-1",
  content: "hello",
  author: { tag: "user#0001" },
  attachments: { size: 0 },
  embeds: [] as EmbedStub[],
  inGuild: () => false,
});

const makeMessage = (overrides: Partial<ReturnType<typeof baseMessageFields>> = {}) =>
  unsafeStub<Message>({ ...baseMessageFields(), ...overrides });

const makeGuildTextMessage = (
  overrides: Partial<{
    content: string;
    guildId: string;
    channelId: string;
    guild: { name: string };
    channel: { type: ChannelType; name: string; topic?: string | null };
  }> = {},
) =>
  unsafeStub<Message>({
    ...baseMessageFields(),
    inGuild: () => true,
    guildId: "g-1",
    channelId: "c-1",
    guild: { name: "Test Guild" },
    channel: { type: ChannelType.GuildText, name: "general", topic: null },
    ...overrides,
  });

describe("summarizeEmbeds", () => {
  test("returns None for messages without embeds", () => {
    expect(summarizeEmbeds(makeMessage())).toBe("None");
  });

  test("formats embed details into a readable summary", () => {
    const message = makeMessage({
      embeds: [
        {
          title: "Title",
          description: "Description",
          url: "https://example.com",
          fields: [{ name: "Alpha", value: "Beta" }],
        },
      ],
    });

    expect(summarizeEmbeds(message)).toBe(
      "- Embed 1 | title=Title | description=Description | url=https://example.com | fields=Alpha: Beta",
    );
  });
});

describe("promptMessageContext", () => {
  test("trims message content and records attachment state", () => {
    const message = makeMessage({
      id: "m-2",
      content: "  hello world  ",
      attachments: { size: 2 },
    });

    expect(promptMessageContext(message)).toEqual({
      userTag: "user#0001",
      messageId: "m-2",
      content: "hello world",
      attachmentContext: "yes",
      embedSummary: "None",
    });
  });

  test("falls back to a placeholder for empty messages", () => {
    const message = makeMessage({
      content: "   ",
    });

    expect(promptMessageContext(message).content).toBe("(empty message)");
  });
});

describe("buildOpencodePrompt", () => {
  test("renders the main Discord message context", () => {
    expect(
      buildOpencodePrompt({
        message: {
          userTag: "user#0001",
          messageId: "m-1",
          content: "hello",
          attachmentContext: "no",
          embedSummary: "None",
        },
      }),
    ).toBe(
      [
        "Discord user: user#0001",
        "Discord message ID: m-1",
        "Message:",
        "hello",
        "",
        "Attachments:",
        "no",
        "",
        "Embed summary:",
        "None",
      ].join("\n"),
    );
  });

  test("renders referenced message context with a prefixed block", () => {
    expect(
      buildOpencodePrompt({
        message: {
          userTag: "user#0001",
          messageId: "m-1",
          content: "hello",
          attachmentContext: "no",
          embedSummary: "None",
        },
        referencedMessage: {
          userTag: "bot#0001",
          messageId: "m-0",
          content: "previous",
          attachmentContext: "yes",
          embedSummary: "Embed 1",
        },
      }),
    ).toBe(
      [
        "Discord user: user#0001",
        "Discord message ID: m-1",
        "Message:",
        "hello",
        "",
        "Attachments:",
        "no",
        "",
        "Embed summary:",
        "None",
        "",
        "Referenced Discord user: bot#0001",
        "Referenced Discord message ID: m-0",
        "Referenced Message:",
        "previous",
        "",
        "Referenced Attachments:",
        "yes",
        "",
        "Referenced Embed summary:",
        "Embed 1",
      ].join("\n"),
    );
  });
});

describe("batched prompt wrappers", () => {
  test("passes through a single batched prompt unchanged", () => {
    expect(buildBatchedOpencodePrompt(["one"])).toBe("one");
  });

  test("wraps multiple batched prompts in indexed blocks", () => {
    expect(buildBatchedOpencodePrompt(["one", "two"])).toBe(
      [
        "Multiple Discord messages arrived before you responded. Read all of them and address them together in order.",
        '<discord-message index="1">\none\n</discord-message>',
        '<discord-message index="2">\ntwo\n</discord-message>',
      ].join("\n\n"),
    );
  });

  test("wraps queued follow-up prompts with the queued heading", () => {
    expect(buildQueuedFollowUpPrompt(["later"])).toBe(
      [
        "Additional Discord messages arrived while you were working. Read all of them, address them, and continue the task.",
        '<discord-message index="1">\nlater\n</discord-message>',
      ].join("\n\n"),
    );
  });
});

describe("buildSessionSystemAppend", () => {
  test("returns only additional instructions when no guild text context is available", () => {
    expect(
      buildSessionSystemAppend({
        message: makeMessage(),
        additionalInstructions: "Be concise.",
      }),
    ).toBe(["Additional instructions:", "Be concise."].join("\n"));
  });

  test("returns guild and channel context without a topic when none exists", () => {
    expect(
      buildSessionSystemAppend({
        message: makeGuildTextMessage(),
        additionalInstructions: "",
      }),
    ).toBe(
      [
        "Discord thread context:",
        "- Server: Test Guild (ID: g-1)",
        "- Channel: #general (ID: c-1)",
      ].join("\n"),
    );
  });

  test("joins additional instructions and guild context with one blank line", () => {
    expect(
      buildSessionSystemAppend({
        message: makeGuildTextMessage({
          channel: { type: ChannelType.GuildText, name: "general", topic: "Work queue" },
        }),
        additionalInstructions: "Be concise.",
      }),
    ).toBe(
      [
        "Additional instructions:",
        "Be concise.",
        "",
        "Discord thread context:",
        "- Server: Test Guild (ID: g-1)",
        "- Channel: #general (ID: c-1)",
        "- Channel topic: Work queue",
      ].join("\n"),
    );
  });
});
