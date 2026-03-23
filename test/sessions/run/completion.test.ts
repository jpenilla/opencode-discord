import { describe, expect, test } from "bun:test";

import { decideRunCompletion } from "@/sessions/run/completion.ts";

describe("decideRunCompletion", () => {
  test("sends the final response when transcript content is present", () => {
    expect(
      decideRunCompletion({
        transcript: "done",
        questionOutcome: { _tag: "none" },
        interruptRequested: false,
      }),
    ).toEqual({ type: "send-final-response" });
  });

  test("sends question UI failure when transcript is empty and the UI failure was not notified", () => {
    expect(
      decideRunCompletion({
        transcript: "  ",
        questionOutcome: {
          _tag: "ui-failure",
          message: "ui failed",
          notified: false,
        },
        interruptRequested: false,
      }),
    ).toEqual({
      type: "send-question-ui-failure",
      message: "ui failed",
    });
  });

  test("suppresses empty interrupted runs", () => {
    expect(
      decideRunCompletion({
        transcript: "",
        questionOutcome: { _tag: "none" },
        interruptRequested: true,
      }),
    ).toEqual({ type: "suppress-response" });
  });

  test("suppresses empty user-rejected question runs", () => {
    expect(
      decideRunCompletion({
        transcript: "",
        questionOutcome: { _tag: "user-rejected" },
        interruptRequested: false,
      }),
    ).toEqual({ type: "suppress-response" });
  });

  test("sends the final response for empty normal runs", () => {
    expect(
      decideRunCompletion({
        transcript: "",
        questionOutcome: { _tag: "none" },
        interruptRequested: false,
      }),
    ).toEqual({ type: "send-final-response" });
  });
});
