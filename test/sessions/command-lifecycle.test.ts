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

const missingChannelActivity = { type: "missing" } as const;

const presentChannelActivity = (activity: {
  hasActiveRun: boolean;
  hasPendingQuestions: boolean;
  hasIdleCompaction: boolean;
  hasQueuedWork: boolean;
  isBusy: boolean;
}) =>
  ({
    type: "present",
    session: {} as never,
    activity,
  }) as const;

describe("decideCompactEntry", () => {
  test("rejects when no session exists", () => {
    expect(
      decideCompactEntry({
        channelActivity: missingChannelActivity,
      }),
    ).toEqual({
      type: "reject",
      message: "No OpenCode session exists in this channel yet.",
    });
  });

  test("rejects when a run is already active", () => {
    expect(
      decideCompactEntry({
        channelActivity: presentChannelActivity({
          hasActiveRun: true,
          hasPendingQuestions: false,
          hasIdleCompaction: false,
          hasQueuedWork: false,
          isBusy: true,
        }),
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
        channelActivity: presentChannelActivity({
          hasActiveRun: false,
          hasPendingQuestions: false,
          hasIdleCompaction: false,
          hasQueuedWork: false,
          isBusy: false,
        }),
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
  test("rejects when no session exists", () => {
    expect(
      decideInterruptEntry({
        channelActivity: missingChannelActivity,
      }),
    ).toEqual({
      type: "reject",
      message: "No OpenCode session exists in this channel yet.",
    });
  });

  test("rejects when no active run or compaction exists", () => {
    expect(
      decideInterruptEntry({
        channelActivity: presentChannelActivity({
          hasActiveRun: false,
          hasPendingQuestions: false,
          hasIdleCompaction: false,
          hasQueuedWork: false,
          isBusy: false,
        }),
      }),
    ).toEqual({
      type: "reject",
      message: "No active OpenCode run or compaction is running in this channel.",
    });
  });

  test("allows active runs through to interruption", () => {
    expect(
      decideInterruptEntry({
        channelActivity: presentChannelActivity({
          hasActiveRun: true,
          hasPendingQuestions: false,
          hasIdleCompaction: false,
          hasQueuedWork: false,
          isBusy: true,
        }),
      }),
    ).toEqual({ type: "defer-and-interrupt", target: "run" });
  });

  test("rejects active run interrupts while a question prompt is pending", () => {
    expect(
      decideInterruptEntry({
        channelActivity: presentChannelActivity({
          hasActiveRun: true,
          hasPendingQuestions: true,
          hasIdleCompaction: false,
          hasQueuedWork: false,
          isBusy: true,
        }),
      }),
    ).toEqual({
      type: "reject",
      message: QUESTION_PENDING_INTERRUPT_MESSAGE,
    });
  });

  test("rejects interrupts while a question prompt is pending without an active run", () => {
    expect(
      decideInterruptEntry({
        channelActivity: presentChannelActivity({
          hasActiveRun: false,
          hasPendingQuestions: true,
          hasIdleCompaction: false,
          hasQueuedWork: false,
          isBusy: true,
        }),
      }),
    ).toEqual({
      type: "reject",
      message: QUESTION_PENDING_INTERRUPT_MESSAGE,
    });
  });

  test("allows active compactions through to interruption", () => {
    expect(
      decideInterruptEntry({
        channelActivity: presentChannelActivity({
          hasActiveRun: false,
          hasPendingQuestions: false,
          hasIdleCompaction: true,
          hasQueuedWork: false,
          isBusy: true,
        }),
      }),
    ).toEqual({ type: "defer-and-interrupt", target: "compaction" });
  });
});

describe("decideNewSessionEntry", () => {
  test("rejects while a question prompt is pending", () => {
    expect(
      decideNewSessionEntry({
        channelActivity: presentChannelActivity({
          hasActiveRun: false,
          hasPendingQuestions: true,
          hasIdleCompaction: false,
          hasQueuedWork: false,
          isBusy: true,
        }),
      }),
    ).toEqual({
      type: "reject",
      message: QUESTION_PENDING_NEW_SESSION_MESSAGE,
    });
  });

  test("rejects while a run is active", () => {
    expect(
      decideNewSessionEntry({
        channelActivity: presentChannelActivity({
          hasActiveRun: true,
          hasPendingQuestions: false,
          hasIdleCompaction: false,
          hasQueuedWork: false,
          isBusy: true,
        }),
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
        channelActivity: presentChannelActivity({
          hasActiveRun: false,
          hasPendingQuestions: false,
          hasIdleCompaction: true,
          hasQueuedWork: false,
          isBusy: true,
        }),
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
        channelActivity: presentChannelActivity({
          hasActiveRun: false,
          hasPendingQuestions: false,
          hasIdleCompaction: false,
          hasQueuedWork: true,
          isBusy: false,
        }),
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
        channelActivity: presentChannelActivity({
          hasActiveRun: false,
          hasPendingQuestions: false,
          hasIdleCompaction: false,
          hasQueuedWork: false,
          isBusy: true,
        }),
      }),
    ).toEqual({
      type: "reject",
      message: NEW_SESSION_BUSY_MESSAGE,
    });
  });

  test("allows fresh-session invalidation when the channel is clear", () => {
    expect(
      decideNewSessionEntry({
        channelActivity: missingChannelActivity,
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
