import { describe, expect, test } from "bun:test";

import {
  decideCompactAfterHealthCheck,
  decideCompactEntry,
  decideInterruptEntry,
  decideNewSessionEntry,
  NEW_SESSION_BUSY_MESSAGE,
  QUESTION_PENDING_NEW_SESSION_MESSAGE,
  decideRunCompletion,
  QUESTION_PENDING_INTERRUPT_MESSAGE,
} from "@/sessions/command-lifecycle.ts";

describe("decideCompactEntry", () => {
  test("rejects non-standard guild text channels", () => {
    expect(
      decideCompactEntry({
        inGuildTextChannel: false,
        hasSession: true,
        hasActiveRun: false,
      }),
    ).toEqual({
      type: "reject",
      message: "This command only works in standard guild text channels.",
    });
  });

  test("rejects when no session exists", () => {
    expect(
      decideCompactEntry({
        inGuildTextChannel: true,
        hasSession: false,
        hasActiveRun: false,
      }),
    ).toEqual({
      type: "reject",
      message: "No OpenCode session exists in this channel yet.",
    });
  });

  test("rejects when a run is already active", () => {
    expect(
      decideCompactEntry({
        inGuildTextChannel: true,
        hasSession: true,
        hasActiveRun: true,
      }),
    ).toEqual({
      type: "reject",
      message:
        "OpenCode is busy in this channel right now. Use /interrupt first or wait for the current run to finish.",
    });
  });

  test("allows idle sessions through to health checking", () => {
    expect(
      decideCompactEntry({
        inGuildTextChannel: true,
        hasSession: true,
        hasActiveRun: false,
      }),
    ).toEqual({ type: "defer-and-check-health" });
  });
});

describe("decideCompactAfterHealthCheck", () => {
  test("rejects unhealthy sessions after defer", () => {
    expect(decideCompactAfterHealthCheck(false)).toEqual({
      type: "reject-after-defer",
      message:
        "This channel session is unavailable right now. Send a normal message to recreate it.",
    });
  });

  test("starts compaction when the session is healthy", () => {
    expect(decideCompactAfterHealthCheck(true)).toEqual({ type: "start-compaction" });
  });
});

describe("decideInterruptEntry", () => {
  test("rejects non-standard guild text channels", () => {
    expect(
      decideInterruptEntry({
        inGuildTextChannel: false,
        hasSession: true,
        hasActiveRun: true,
        hasPendingQuestions: false,
        hasIdleCompaction: false,
      }),
    ).toEqual({
      type: "reject",
      message: "This command only works in standard guild text channels.",
    });
  });

  test("rejects when no session exists", () => {
    expect(
      decideInterruptEntry({
        inGuildTextChannel: true,
        hasSession: false,
        hasActiveRun: false,
        hasPendingQuestions: false,
        hasIdleCompaction: false,
      }),
    ).toEqual({
      type: "reject",
      message: "No OpenCode session exists in this channel yet.",
    });
  });

  test("rejects when no active run or compaction exists", () => {
    expect(
      decideInterruptEntry({
        inGuildTextChannel: true,
        hasSession: true,
        hasActiveRun: false,
        hasPendingQuestions: false,
        hasIdleCompaction: false,
      }),
    ).toEqual({
      type: "reject",
      message: "No active OpenCode run or compaction is running in this channel.",
    });
  });

  test("allows active runs through to interruption", () => {
    expect(
      decideInterruptEntry({
        inGuildTextChannel: true,
        hasSession: true,
        hasActiveRun: true,
        hasPendingQuestions: false,
        hasIdleCompaction: false,
      }),
    ).toEqual({ type: "defer-and-interrupt", target: "run" });
  });

  test("rejects active run interrupts while a question prompt is pending", () => {
    expect(
      decideInterruptEntry({
        inGuildTextChannel: true,
        hasSession: true,
        hasActiveRun: true,
        hasPendingQuestions: true,
        hasIdleCompaction: false,
      }),
    ).toEqual({
      type: "reject",
      message: QUESTION_PENDING_INTERRUPT_MESSAGE,
    });
  });

  test("rejects interrupts while a question prompt is pending without an active run", () => {
    expect(
      decideInterruptEntry({
        inGuildTextChannel: true,
        hasSession: true,
        hasActiveRun: false,
        hasPendingQuestions: true,
        hasIdleCompaction: false,
      }),
    ).toEqual({
      type: "reject",
      message: QUESTION_PENDING_INTERRUPT_MESSAGE,
    });
  });

  test("allows active compactions through to interruption", () => {
    expect(
      decideInterruptEntry({
        inGuildTextChannel: true,
        hasSession: true,
        hasActiveRun: false,
        hasPendingQuestions: false,
        hasIdleCompaction: true,
      }),
    ).toEqual({ type: "defer-and-interrupt", target: "compaction" });
  });
});

describe("decideNewSessionEntry", () => {
  test("rejects non-standard guild text channels", () => {
    expect(
      decideNewSessionEntry({
        inGuildTextChannel: false,
        hasPendingQuestions: false,
        hasActiveRun: false,
        hasIdleCompaction: false,
        hasQueuedWork: false,
        hasOtherBusyState: false,
      }),
    ).toEqual({
      type: "reject",
      message: "This command only works in standard guild text channels.",
    });
  });

  test("rejects while a question prompt is pending", () => {
    expect(
      decideNewSessionEntry({
        inGuildTextChannel: true,
        hasPendingQuestions: true,
        hasActiveRun: false,
        hasIdleCompaction: false,
        hasQueuedWork: false,
        hasOtherBusyState: false,
      }),
    ).toEqual({
      type: "reject",
      message: QUESTION_PENDING_NEW_SESSION_MESSAGE,
    });
  });

  test("rejects while a run is active", () => {
    expect(
      decideNewSessionEntry({
        inGuildTextChannel: true,
        hasPendingQuestions: false,
        hasActiveRun: true,
        hasIdleCompaction: false,
        hasQueuedWork: false,
        hasOtherBusyState: false,
      }),
    ).toEqual({
      type: "reject",
      message:
        "OpenCode is busy in this channel right now. Wait for the current run to finish or use /interrupt before starting a fresh session.",
    });
  });

  test("rejects while compaction is active", () => {
    expect(
      decideNewSessionEntry({
        inGuildTextChannel: true,
        hasPendingQuestions: false,
        hasActiveRun: false,
        hasIdleCompaction: true,
        hasQueuedWork: false,
        hasOtherBusyState: false,
      }),
    ).toEqual({
      type: "reject",
      message:
        "OpenCode is compacting this channel right now. Wait for compaction to finish or use /interrupt before starting a fresh session.",
    });
  });

  test("rejects while queued work is pending", () => {
    expect(
      decideNewSessionEntry({
        inGuildTextChannel: true,
        hasPendingQuestions: false,
        hasActiveRun: false,
        hasIdleCompaction: false,
        hasQueuedWork: true,
        hasOtherBusyState: false,
      }),
    ).toEqual({
      type: "reject",
      message:
        "OpenCode still has queued work for this channel. Wait for it to finish before starting a fresh session.",
    });
  });

  test("rejects generic busy states after more specific cases are ruled out", () => {
    expect(
      decideNewSessionEntry({
        inGuildTextChannel: true,
        hasPendingQuestions: false,
        hasActiveRun: false,
        hasIdleCompaction: false,
        hasQueuedWork: false,
        hasOtherBusyState: true,
      }),
    ).toEqual({
      type: "reject",
      message: NEW_SESSION_BUSY_MESSAGE,
    });
  });

  test("allows fresh-session invalidation when the channel is clear", () => {
    expect(
      decideNewSessionEntry({
        inGuildTextChannel: true,
        hasPendingQuestions: false,
        hasActiveRun: false,
        hasIdleCompaction: false,
        hasQueuedWork: false,
        hasOtherBusyState: false,
      }),
    ).toEqual({ type: "defer-and-invalidate" });
  });
});

describe("decideRunCompletion", () => {
  test("sends the final response when transcript content is present", () => {
    expect(
      decideRunCompletion({
        transcript: "hello",
        questionOutcome: { _tag: "none" },
        interruptRequested: true,
      }),
    ).toEqual({ type: "send-final-response" });
  });

  test("sends question UI failure when transcript is empty and the UI failure was not notified", () => {
    expect(
      decideRunCompletion({
        transcript: "   ",
        questionOutcome: { _tag: "ui-failure", message: "boom", notified: false },
        interruptRequested: false,
      }),
    ).toEqual({ type: "send-question-ui-failure", message: "boom" });
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
