import { describe, expect, test } from "bun:test";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import type { Message, MessageCreateOptions } from "discord.js";

import { upsertToolCard } from "@/discord/tool-card.ts";
import { unsafeStub } from "../support/stub.ts";

const WORKDIR = "/home/opencode/workspace";

const cardText = (payload: MessageCreateOptions) =>
  String(
    (payload as { components?: Array<{ components?: Array<{ data?: { content?: string } }> }> })
      .components?.[0]?.components?.[0]?.data?.content ?? "",
  );

const makeToolPart = (input: {
  tool: string;
  status: "running" | "completed" | "error";
  toolInput?: Record<string, unknown>;
  title?: string;
  raw?: string;
  output?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}): ToolPart =>
  unsafeStub<ToolPart>({
    id: `${input.tool}-${input.status}`,
    sessionID: "session-1",
    messageID: "assistant-1",
    callID: "call-1",
    tool: input.tool,
    state: {
      status: input.status,
      input: input.toolInput ?? {},
      title: input.title,
      raw: input.raw,
      output: input.output,
      metadata: input.metadata,
      error: input.error,
      time: input.status === "running" ? { start: 1 } : { start: 1, end: 1 },
    },
  });

const renderCard = async (part: ToolPart) => {
  let payload: MessageCreateOptions | null = null;
  const sourceMessage = unsafeStub<Message>({
    channel: unsafeStub({
      isSendable: () => true,
      send: async (nextPayload: MessageCreateOptions) => {
        payload = nextPayload;
        return unsafeStub<Message>({});
      },
    }),
  });

  await upsertToolCard({
    sourceMessage,
    existingCard: null,
    part,
    workdir: WORKDIR,
  });

  if (!payload) {
    throw new Error("tool card payload was not sent");
  }

  return cardText(payload);
};

describe("tool card formatting", () => {
  test("renders read cards with a plain path summary and no step line", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "read",
        status: "running",
        toolInput: {
          filePath: "/home/opencode/workspace/src/discord/tool-card.ts",
          offset: 10,
          limit: 20,
        },
        title: "src/discord/tool-card.ts",
      }),
    );

    expect(text).toBe("**📖 🛠️ `read` Running**\n`./src/discord/tool-card.ts`");
  });

  test("renders apply_patch cards from patchText without an edited label", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "apply_patch",
        status: "completed",
        toolInput: {
          patchText:
            "*** Update File: /home/opencode/workspace/src/discord/tool-card.ts\n@@\n-old\n+new",
        },
        output: "",
      }),
    );

    expect(text).toBe("**🩹 ✅ `apply_patch` Completed in 0.00s**\n`./src/discord/tool-card.ts`");
  });

  test("renders apply_patch fallback text when no files can be extracted", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "apply_patch",
        status: "completed",
        toolInput: {
          patchText: "@@ noop @@",
        },
        output: "",
      }),
    );

    expect(text).toBe("**🩹 ✅ `apply_patch` Completed in 0.00s**\nApplied patch");
  });

  test("deduplicates mixed patch path variants to one summary line", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "apply_patch",
        status: "completed",
        toolInput: {
          patchText: "*** Add File: ./notes/rust-audit.md\n+hello",
        },
        output: "A home/opencode/workspace/notes/rust-audit.md",
      }),
    );

    expect(text).toBe("**🩹 ✅ `apply_patch` Completed in 0.00s**\n`./notes/rust-audit.md`");
  });

  test("renders write cards with a plain path summary and metadata bullets", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "write",
        status: "running",
        toolInput: {
          filePath: "/home/opencode/workspace/src/generated.txt",
          content: "hello",
        },
        title: "src/generated.txt",
      }),
    );

    expect(text).toBe("**✏️ 🛠️ `write` Running**\n`./src/generated.txt`\n- Size: `5 chars`");
  });

  test("renders task cards with the description as the primary summary line", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "task",
        status: "running",
        toolInput: {
          description: "Investigate tool card noise",
          subagent_type: "explorer",
          model: "gpt-5",
        },
        title: "Investigate tool card noise",
      }),
    );

    expect(text).toBe(
      "**🧩 🛠️ `task` Running**\n`Investigate tool card noise`\n- Agent: `explorer`\n- Model: `gpt-5`",
    );
  });

  test("renders webfetch cards with a plain URL summary and secondary metadata", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "webfetch",
        status: "completed",
        toolInput: {
          url: "https://example.com/docs?q=tool-card",
          format: "html",
        },
        title: "https://example.com/docs?q=tool-card (text/html)",
      }),
    );

    expect(text).toBe(
      "**🌐 ✅ `webfetch` Completed in 0.00s**\n`example.com/docs?q=tool-card`\n- Format: `html`\n- Response: `HTML`",
    );
  });

  test("renders codesearch cards with the query as the primary summary line", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "codesearch",
        status: "running",
        toolInput: {
          query: "tool-card render",
        },
        title: "Code search: tool-card render",
      }),
    );

    expect(text).toBe("**🧠 🛠️ `codesearch` Running**\n`tool-card render`");
  });
});
