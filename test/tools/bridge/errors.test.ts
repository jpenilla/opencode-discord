import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { classifyToolBridgeFailure } from "@/tools/bridge/errors.ts";

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

  test("unwraps Effect UnknownException wrappers for Discord API failures", async () => {
    const discordApiError = {
      name: "DiscordAPIError[50035]",
      message: "Invalid Form Body\nfiles[0]: This file cannot be sent",
      status: 400,
      code: 50035,
      rawError: { message: "Invalid Form Body" },
    };

    const wrapped = await Effect.runPromise(
      Effect.tryPromise(() => Promise.reject(discordApiError)).pipe(
        Effect.result,
        Effect.map((result) => {
          if (result._tag !== "Failure") {
            throw new Error("expected failure");
          }
          return result.failure;
        }),
      ),
    );

    expect(classifyToolBridgeFailure("file upload", wrapped)).toEqual({
      kind: "discord-api",
      status: 502,
      error:
        "Discord rejected file upload (status 400, code 50035): Invalid Form Body\nfiles[0]: This file cannot be sent",
    });
  });
});
