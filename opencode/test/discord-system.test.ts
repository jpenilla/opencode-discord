import { afterEach, describe, expect, test } from "bun:test";

import { DiscordSystemPlugin } from "../plugins/discord-system.ts";

const SYSTEM_APPEND_ENV = "OPENCODE_DISCORD_SYSTEM_APPEND";

afterEach(() => {
  delete process.env[SYSTEM_APPEND_ENV];
});

describe("DiscordSystemPlugin", () => {
  test("appends the trimmed session context when a session id is present", async () => {
    process.env[SYSTEM_APPEND_ENV] = "  appendix  ";

    const plugin = await DiscordSystemPlugin({} as never);
    const transform = plugin["experimental.chat.system.transform"];
    const output = { system: ["base"] };

    await transform?.({ sessionID: "ses-1" } as never, output as never);

    expect(output.system).toEqual(["base", "appendix"]);
  });

  test.each([
    ["session is missing", {}, "appendix"],
    ["env is missing", { sessionID: "ses-1" }, undefined],
    ["env is blank", { sessionID: "ses-1" }, "   "],
  ])("leaves the system prompt unchanged when %s", async (_label, input, appendix) => {
    if (appendix !== undefined) {
      process.env[SYSTEM_APPEND_ENV] = appendix;
    }

    const plugin = await DiscordSystemPlugin({} as never);
    const transform = plugin["experimental.chat.system.transform"];
    const output = { system: ["base"] };

    await transform?.(input as never, output as never);

    expect(output.system).toEqual(["base"]);
  });
});
