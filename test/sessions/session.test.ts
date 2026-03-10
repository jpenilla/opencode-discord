import { describe, expect, test } from "bun:test";

import { buildSessionCreateSpec } from "@/sessions/session.ts";

describe("buildSessionCreateSpec", () => {
  test("preserves the full appended system context", () => {
    const appendix = [
      "Additional instructions:",
      "Be concise.",
      "",
      "Discord thread context:",
      "- Server: Guild (ID: g-1)",
      "- Channel: #general (ID: c-1)",
    ].join("\n");

    expect(
      buildSessionCreateSpec({
        channelId: "123",
        workdir: "/tmp/workspace",
        systemPromptAppend: appendix,
      }),
    ).toEqual({
      workdir: "/tmp/workspace",
      title: "Discord #123",
      systemPromptAppend: appendix,
    });
  });
});
