import { describe, expect, test } from "bun:test";

import {
  buildPromptRequestInput,
  hasIncompletePromptModelOverride,
  resolvePromptModelOverride,
} from "@/opencode/prompt-model.ts";

describe("prompt model override", () => {
  test("returns null when no override is configured", () => {
    expect(
      resolvePromptModelOverride({
        defaultProviderId: undefined,
        defaultModelId: undefined,
      }),
    ).toBeNull();
    expect(
      hasIncompletePromptModelOverride({
        defaultProviderId: undefined,
        defaultModelId: undefined,
      }),
    ).toBe(false);
  });

  test("returns null and marks incomplete when only one field is configured", () => {
    expect(
      resolvePromptModelOverride({
        defaultProviderId: "openai",
        defaultModelId: undefined,
      }),
    ).toBeNull();
    expect(
      hasIncompletePromptModelOverride({
        defaultProviderId: "openai",
        defaultModelId: undefined,
      }),
    ).toBe(true);
  });

  test("returns the prompt override literally when both fields are configured", () => {
    expect(
      resolvePromptModelOverride({
        defaultProviderId: " openai ",
        defaultModelId: " gpt-5 ",
      }),
    ).toEqual({
      providerID: " openai ",
      modelID: " gpt-5 ",
    });
    expect(
      hasIncompletePromptModelOverride({
        defaultProviderId: " openai ",
        defaultModelId: " gpt-5 ",
      }),
    ).toBe(false);
  });

  test("builds prompt input without a model when no override is configured", () => {
    expect(buildPromptRequestInput("session-1", "hello", null)).toEqual({
      sessionID: "session-1",
      noReply: false,
      parts: [{ type: "text", text: "hello" }],
    });
  });

  test("builds prompt input with a model when an override is configured", () => {
    expect(
      buildPromptRequestInput("session-1", "hello", {
        providerID: "openai",
        modelID: "gpt-5",
      }),
    ).toEqual({
      sessionID: "session-1",
      model: {
        providerID: "openai",
        modelID: "gpt-5",
      },
      noReply: false,
      parts: [{ type: "text", text: "hello" }],
    });
  });
});
