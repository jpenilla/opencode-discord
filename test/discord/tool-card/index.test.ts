import { describe, expect, test } from "bun:test";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import type { Message, MessageCreateOptions } from "discord.js";
import type { ResolvedSandboxBackend } from "@/sandbox/common.ts";
import { Effect } from "effect";

import { upsertToolCard } from "@/discord/tool-card/index.ts";
import { cardText, makeSendableChannel } from "../../support/discord.ts";
import { unsafeStub } from "../../support/stub.ts";

const WORKDIR = "/home/opencode/workspace";
const UNSAFE_WORKDIR = "/Users/jason/project";

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

const renderCard = async (
  part: ToolPart,
  {
    workdir = WORKDIR,
    backend = "bwrap",
  }: { workdir?: string; backend?: ResolvedSandboxBackend } = {},
) => {
  let payload: MessageCreateOptions | null = null;
  const channel = makeSendableChannel({
    send: async (nextPayload: MessageCreateOptions) => {
      payload = nextPayload;
      return unsafeStub<Message>({});
    },
  });

  await Effect.runPromise(
    upsertToolCard({
      channel,
      existingCard: null,
      part,
      workdir,
      backend,
    }),
  );

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

    expect(text).toBe(
      "**🩹 ✅ `apply_patch` Completed in 0.00s**\n✏️ Modified: `./src/discord/tool-card.ts`",
    );
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

  test("deduplicates mixed patch path variants within a patch action group", async () => {
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

    expect(text).toBe(
      "**🩹 ✅ `apply_patch` Completed in 0.00s**\n➕ Added: `./notes/rust-audit.md`",
    );
  });

  test("renders apply_patch cards with separate add modify and remove groups", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "apply_patch",
        status: "completed",
        toolInput: {
          patchText: [
            "*** Add File: ./src/new-tool.ts",
            "+hello",
            "*** Update File: ./src/existing-tool.ts",
            "@@",
            "-old",
            "+new",
            "*** Delete File: ./src/old-tool.ts",
            "-bye",
          ].join("\n"),
        },
        output: "",
      }),
    );

    expect(text).toBe(
      [
        "**🩹 ✅ `apply_patch` Completed in 0.00s**",
        "➕ Added: `./src/new-tool.ts`",
        "✏️ Modified: `./src/existing-tool.ts`",
        "🗑️ Removed: `./src/old-tool.ts`",
      ].join("\n"),
    );
  });

  test("prefers delete status output over a trailing update header", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "apply_patch",
        status: "completed",
        toolInput: {
          patchText: "*** Update File: ./src/old-tool.ts\n@@\n-old\n+new",
        },
        output: "D ./src/old-tool.ts",
      }),
    );

    expect(text).toBe(
      "**🩹 ✅ `apply_patch` Completed in 0.00s**\n🗑️ Removed: `./src/old-tool.ts`",
    );
  });

  test("renders renames as a remove plus an add when status output is present", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "apply_patch",
        status: "completed",
        toolInput: {
          patchText: "*** Update File: ./src/old-tool.ts\n@@\n-old\n+new",
        },
        output: "R100 ./src/old-tool.ts -> ./src/new-tool.ts",
      }),
    );

    expect(text).toBe(
      [
        "**🩹 ✅ `apply_patch` Completed in 0.00s**",
        "➕ Added: `./src/new-tool.ts`",
        "🗑️ Removed: `./src/old-tool.ts`",
      ].join("\n"),
    );
  });

  test("deduplicates /var and /private/var patch variants without resolving symlinks", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "apply_patch",
        status: "completed",
        toolInput: {
          patchText: "*** Add File: ./notes/rust-audit.md\n+hello",
        },
        output: "A /private/var/folders/abc/project/notes/rust-audit.md",
      }),
      {
        workdir: "/var/folders/abc/project",
        backend: "unsafe-dev",
      },
    );

    expect(text).toBe(
      "**🩹 ✅ `apply_patch` Completed in 0.00s**\n➕ Added: `./notes/rust-audit.md`",
    );
  });

  test("leaves unstructured bash text unchanged", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "bash",
        status: "running",
        toolInput: {
          cmd: "curl https://example.com/docs?q=tool-card",
        },
        title: "curl https://example.com/docs?q=tool-card",
      }),
    );

    expect(text).toBe(
      "**💻 🛠️ `bash` Running**\n`curl https://example.com/docs?q=tool-card`\ncurl https://example.com/docs?q=tool-card",
    );
  });

  test("does not reinterpret sandbox aliases in unsafe-dev path fields", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "read",
        status: "running",
        toolInput: {
          filePath: "/home/opencode/workspace/src/discord/tool-card.ts",
        },
        title: "src/discord/tool-card.ts",
      }),
      {
        workdir: UNSAFE_WORKDIR,
        backend: "unsafe-dev",
      },
    );

    expect(text).toBe(
      "**📖 🛠️ `read` Running**\n`/home/opencode/workspace/src/discord/tool-card.ts`",
    );
  });

  test("still renders host paths relative to the workdir in unsafe-dev", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "read",
        status: "running",
        toolInput: {
          filePath: "/Users/jason/project/src/discord/tool-card.ts",
        },
        title: "src/discord/tool-card.ts",
      }),
      {
        workdir: UNSAFE_WORKDIR,
        backend: "unsafe-dev",
      },
    );

    expect(text).toBe("**📖 🛠️ `read` Running**\n`./src/discord/tool-card.ts`");
  });

  test("renders write cards with a plain path summary and compact metadata", async () => {
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

    expect(text).toBe("**✏️ 🛠️ `write` Running**\n`./src/generated.txt`\nSize: `5 chars`");
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
      "**🧩 🛠️ `task` Running**\n`Investigate tool card noise`\nAgent: `explorer` | Model: `gpt-5`",
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
      "**🌐 ✅ `webfetch` Completed in 0.00s**\n`example.com/docs?q=tool-card`\nRequested: `html` | Response: `text/html`",
    );
  });

  test("keeps both webfetch format and response when they differ", async () => {
    const text = await renderCard(
      makeToolPart({
        tool: "webfetch",
        status: "completed",
        toolInput: {
          url: "https://example.com/docs?q=tool-card",
          format: "json",
        },
        title: "https://example.com/docs?q=tool-card (text/html)",
      }),
    );

    expect(text).toBe(
      "**🌐 ✅ `webfetch` Completed in 0.00s**\n`example.com/docs?q=tool-card`\nRequested: `json` | Response: `text/html`",
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
