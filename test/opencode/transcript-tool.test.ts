import { describe, expect, test } from "bun:test";

import { renderToolTranscriptPart } from "@/opencode/transcript-tool.ts";

describe("renderToolTranscriptPart", () => {
  test("suppresses dismissed question errors", () => {
    expect(
      renderToolTranscriptPart({
        tool: "question",
        state: {
          status: "error",
          error: "Error: The user dismissed this question",
        },
      }),
    ).toBe("");
  });

  test("suppresses aborted tool errors", () => {
    expect(
      renderToolTranscriptPart({
        tool: "bash",
        state: {
          status: "error",
          input: {},
          error: "Tool execution aborted",
        },
      }),
    ).toBe("");
  });

  test("renders real tool failures", () => {
    expect(
      renderToolTranscriptPart({
        tool: "bash",
        state: {
          status: "error",
          input: {},
          error: "ENOENT: no such file or directory",
        },
      }),
    ).toContain("## ❌ Tool: `bash`");
  });
});
