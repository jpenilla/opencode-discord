import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";

import { parseAppConfig } from "@/config.ts";

describe("parseAppConfig", () => {
  test("rejects an empty DISCORD_TOKEN", async () => {
    const provider = ConfigProvider.fromDotEnvContents("DISCORD_TOKEN=\n").pipe(
      ConfigProvider.constantCase,
    );

    await expect(Effect.runPromise(parseAppConfig(provider))).rejects.toThrow("discordToken");
  });

  test("accepts a non-empty DISCORD_TOKEN and keeps it redacted", async () => {
    const provider = ConfigProvider.fromDotEnvContents("DISCORD_TOKEN=token-123\n").pipe(
      ConfigProvider.constantCase,
    );

    await expect(Effect.runPromise(parseAppConfig(provider))).resolves.toMatchObject({
      discordToken: expect.anything(),
    });
  });

  test("parses comma-separated string lists for sandbox config", async () => {
    const provider = ConfigProvider.fromDotEnvContents(
      [
        "DISCORD_TOKEN=token-123",
        "SANDBOX_READ_ONLY_PATHS=/tmp/foo,/tmp/bar",
        "SANDBOX_ENV_PASSTHROUGH=HOME,PATH",
      ].join("\n"),
    ).pipe(ConfigProvider.constantCase);

    await expect(Effect.runPromise(parseAppConfig(provider))).resolves.toMatchObject({
      sandboxReadOnlyPaths: ["/tmp/foo", "/tmp/bar"],
      sandboxEnvPassthrough: ["HOME", "PATH"],
    });
  });

  test("treats an empty sandbox list env var as an empty list", async () => {
    const provider = ConfigProvider.fromDotEnvContents(
      ["DISCORD_TOKEN=token-123", "SANDBOX_READ_ONLY_PATHS="].join("\n"),
    ).pipe(ConfigProvider.constantCase);

    await expect(Effect.runPromise(parseAppConfig(provider))).resolves.toMatchObject({
      sandboxReadOnlyPaths: [],
    });
  });
});
