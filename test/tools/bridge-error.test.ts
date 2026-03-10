import { describe, expect, test } from "bun:test";

import { classifyToolBridgeFailure } from "@/tools/bridge-error.ts";

describe("classifyToolBridgeFailure", () => {
  test("classifies Discord API upload failures separately from bridge failures", () => {
    expect(
      classifyToolBridgeFailure("file upload", {
        name: "DiscordAPIError[50035]",
        message: "Invalid Form Body\nfiles[0]: This file cannot be sent",
        status: 400,
        code: 50035,
        rawError: { message: "Invalid Form Body" },
      }),
    ).toEqual({
      kind: "discord-api",
      status: 502,
      error:
        "Discord rejected file upload (status 400, code 50035): Invalid Form Body\nfiles[0]: This file cannot be sent",
    });
  });

  test("formats local bridge failures as internal bridge errors", () => {
    expect(
      classifyToolBridgeFailure("file upload", new Error("socket closed before response")),
    ).toEqual({
      kind: "bridge-internal",
      status: 500,
      error: "Discord bridge failed while performing file upload: socket closed before response",
    });
  });
});
