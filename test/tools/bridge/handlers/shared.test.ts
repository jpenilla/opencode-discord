import { describe, expect, test } from "bun:test";
import type { SendableChannels } from "discord.js";
import { Effect, Result } from "effect";

import { sendBridgeMessage } from "@/tools/bridge/handlers/shared.ts";
import { unsafeStub } from "../../../support/stub.ts";

describe("sendBridgeMessage", () => {
  test("preserves Discord API failures for bridge error classification", async () => {
    const error = {
      name: "DiscordAPIError[50035]",
      message: "Invalid Form Body\nfiles[0]: This file cannot be sent",
      status: 400,
      code: 50035,
      rawError: {
        message: "Invalid Form Body",
      },
    };
    const channel = unsafeStub<SendableChannels>({
      send: () => Promise.reject(error),
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
    expect(result.failure).toMatchObject(error);
  });
});
