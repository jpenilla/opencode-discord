import { describe, expect, test } from "bun:test";
import type { SendableChannels } from "discord.js";
import { Effect, Result } from "effect";

import { classifyToolBridgeFailure } from "@/tools/bridge/errors.ts";
import { sendBridgeMessage } from "@/tools/bridge/handlers/shared.ts";
import {
  discordApiValidationMessage,
  makeDiscordApiError,
} from "../../../support/discord-api-error.ts";
import { unsafeStub } from "../../../support/stub.ts";

describe("sendBridgeMessage", () => {
  test("preserves Discord API failures for bridge error classification", async () => {
    const channel = unsafeStub<SendableChannels>({
      send: () => Promise.reject(makeDiscordApiError()),
    });

    const result = await Effect.runPromise(
      Effect.result(
        sendBridgeMessage(channel, {
          content: "hello",
        }),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) {
      throw new Error("expected sendBridgeMessage to fail");
    }
    expect(classifyToolBridgeFailure("message send", result.failure)).toEqual({
      kind: "discord-api",
      status: 502,
      error: `Discord rejected message send (status 400, code 50035): ${discordApiValidationMessage}`,
    });
  });
});
