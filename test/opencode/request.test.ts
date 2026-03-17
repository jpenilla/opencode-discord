import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { requestData, requestOk, requestTrue } from "@/opencode/request.ts";

describe("opencode request helpers", () => {
  test("convert rejected SDK promises into recoverable failures", async () => {
    const exit = await Effect.runPromiseExit(
      requestData("Failed to load opencode session", async () => {
        throw new Error("network down");
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("Failed to load opencode session");
      expect(String(exit.cause)).toContain("network down");
    }
  });

  test("convert SDK error payloads into recoverable failures", async () => {
    const exit = await Effect.runPromiseExit(
      requestTrue("Failed to interrupt opencode session", async () => ({
        error: "session is already closed",
        data: false,
      })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("Failed to interrupt opencode session");
      expect(String(exit.cause)).toContain("session is already closed");
    }
  });

  test("reject empty data results instead of succeeding with nullish payloads", async () => {
    const exit = await Effect.runPromiseExit(
      requestData("Failed to attach opencode session", async () => ({
        data: null,
      })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("unexpected empty response");
    }
  });

  test("keep success responses unchanged", async () => {
    await expect(
      Effect.runPromise(
        requestOk("Failed to prompt opencode", async () => ({
          error: undefined,
        })),
      ),
    ).resolves.toBeUndefined();
  });
});
