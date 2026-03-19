import { describe, expect, test } from "bun:test";

import {
  decideCompactAfterHealthCheck,
  decideCompactEntry,
  decideInterruptEntry,
  decideNewSessionEntry,
  NEW_SESSION_BUSY_MESSAGE,
  QUESTION_PENDING_INTERRUPT_MESSAGE,
  QUESTION_PENDING_NEW_SESSION_MESSAGE,
} from "@/channels/command-policy.ts";

const missingChannelActivity = { type: "missing" } as const;
const activity = (input: {
  hasActiveRun?: boolean;
  hasPendingQuestions?: boolean;
  hasIdleCompaction?: boolean;
  hasQueuedWork?: boolean;
  isBusy?: boolean;
}) =>
  ({
    type: "present",
    activity: {
      hasActiveRun: false,
      hasPendingQuestions: false,
      hasIdleCompaction: false,
      hasQueuedWork: false,
      isBusy: false,
      ...input,
    },
  }) as const;

describe("decideCompactEntry", () => {
  for (const scenario of [
    {
      name: "rejects when no session exists",
      channelActivity: missingChannelActivity,
      expected: {
        type: "reject",
        message: "No OpenCode session exists in this channel yet.",
      },
    },
    {
      name: "rejects when a run is already active",
      channelActivity: activity({ hasActiveRun: true, isBusy: true }),
      expected: {
        type: "reject",
        message:
          "OpenCode is busy in this channel right now. Use /interrupt first or wait for the current run to finish.",
      },
    },
    {
      name: "allows idle sessions through to health checking",
      channelActivity: activity({}),
      expected: { type: "defer-and-check-health" },
    },
  ] as const) {
    test(scenario.name, () => {
      expect(decideCompactEntry({ channelActivity: scenario.channelActivity })).toEqual(
        scenario.expected,
      );
    });
  }
});

describe("decideCompactAfterHealthCheck", () => {
  for (const [healthy, expected] of [
    [
      false,
      {
        type: "reject-after-defer",
        message:
          "This channel session is unavailable right now. Send a normal message to recreate it.",
      },
    ],
    [true, { type: "start-compaction" }],
  ] as const) {
    test(`returns ${expected.type} when healthy=${healthy}`, () => {
      expect(decideCompactAfterHealthCheck(healthy)).toEqual(expected);
    });
  }
});

describe("decideInterruptEntry", () => {
  for (const scenario of [
    {
      name: "rejects when no session exists",
      channelActivity: missingChannelActivity,
      expected: {
        type: "reject",
        message: "No OpenCode session exists in this channel yet.",
      },
    },
    {
      name: "rejects when no active run or compaction exists",
      channelActivity: activity({}),
      expected: {
        type: "reject",
        message: "No active OpenCode run or compaction is running in this channel.",
      },
    },
    {
      name: "allows active runs through to interruption",
      channelActivity: activity({ hasActiveRun: true, isBusy: true }),
      expected: { type: "defer-and-interrupt", target: "run" },
    },
    {
      name: "rejects active run interrupts while a question prompt is pending",
      channelActivity: activity({ hasActiveRun: true, hasPendingQuestions: true, isBusy: true }),
      expected: { type: "reject", message: QUESTION_PENDING_INTERRUPT_MESSAGE },
    },
    {
      name: "rejects interrupts while a question prompt is pending without an active run",
      channelActivity: activity({ hasPendingQuestions: true, isBusy: true }),
      expected: { type: "reject", message: QUESTION_PENDING_INTERRUPT_MESSAGE },
    },
    {
      name: "allows active compactions through to interruption",
      channelActivity: activity({ hasIdleCompaction: true, isBusy: true }),
      expected: { type: "defer-and-interrupt", target: "compaction" },
    },
  ] as const) {
    test(scenario.name, () => {
      expect(decideInterruptEntry({ channelActivity: scenario.channelActivity })).toEqual(
        scenario.expected,
      );
    });
  }
});

describe("decideNewSessionEntry", () => {
  for (const scenario of [
    {
      name: "rejects while a question prompt is pending",
      channelActivity: activity({ hasPendingQuestions: true, isBusy: true }),
      expected: { type: "reject", message: QUESTION_PENDING_NEW_SESSION_MESSAGE },
    },
    {
      name: "rejects while a run is active",
      channelActivity: activity({ hasActiveRun: true, isBusy: true }),
      expected: {
        type: "reject",
        message:
          "OpenCode is busy in this channel right now. Wait for the current run to finish or use /interrupt before starting a fresh session.",
      },
    },
    {
      name: "rejects while compaction is active",
      channelActivity: activity({ hasIdleCompaction: true, isBusy: true }),
      expected: {
        type: "reject",
        message:
          "OpenCode is compacting this channel right now. Wait for compaction to finish or use /interrupt before starting a fresh session.",
      },
    },
    {
      name: "rejects while queued work is pending",
      channelActivity: activity({ hasQueuedWork: true, isBusy: true }),
      expected: {
        type: "reject",
        message:
          "OpenCode still has queued work for this channel. Wait for it to finish before starting a fresh session.",
      },
    },
    {
      name: "rejects generic busy states after more specific cases are ruled out",
      channelActivity: activity({ isBusy: true }),
      expected: { type: "reject", message: NEW_SESSION_BUSY_MESSAGE },
    },
    {
      name: "allows fresh-session invalidation when the channel is clear",
      channelActivity: missingChannelActivity,
      expected: { type: "defer-and-invalidate" },
    },
  ] as const) {
    test(scenario.name, () => {
      expect(decideNewSessionEntry({ channelActivity: scenario.channelActivity })).toEqual(
        scenario.expected,
      );
    });
  }
});
