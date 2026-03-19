import { describe, expect, test } from "bun:test";
import { classifyToolBridgeFailure } from "@/tools/bridge/errors.ts";
import {
  discordApiValidationMessage,
  makeDiscordApiError,
} from "../../support/discord-api-error.ts";

describe("classifyToolBridgeFailure", () => {
  test("classifies Discord API upload failures separately from bridge failures", () => {
    expect(classifyToolBridgeFailure("file upload", makeDiscordApiError())).toEqual({
      kind: "discord-api",
      status: 502,
      error: `Discord rejected file upload (status 400, code 50035): ${discordApiValidationMessage}`,
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
