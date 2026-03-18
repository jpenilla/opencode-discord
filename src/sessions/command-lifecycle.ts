import type { ChannelActivity } from "@/sessions/session-control.ts";
import type { QuestionOutcome } from "@/sessions/session.ts";

export type CommandRejection = { type: "reject"; message: string };
export const GUILD_TEXT_COMMAND_ONLY_MESSAGE =
  "This command only works in standard guild text channels.";
export const QUESTION_PENDING_INTERRUPT_MESSAGE =
  "A question prompt is awaiting input in this channel. Answer it or reject it instead of using /interrupt.";
export const QUESTION_PENDING_NEW_SESSION_MESSAGE =
  "A question prompt is awaiting input in this channel. Answer it or reject it before starting a fresh session.";
export const NEW_SESSION_BUSY_MESSAGE =
  "OpenCode is busy in this channel right now. Wait for the current work to finish or use /interrupt before starting a fresh session.";

export const decideCompactEntry = (input: {
  inGuildTextChannel: boolean;
  channelActivity: ChannelActivity;
}): CommandRejection | { type: "defer-and-check-health" } => {
  if (!input.inGuildTextChannel) {
    return { type: "reject", message: GUILD_TEXT_COMMAND_ONLY_MESSAGE };
  }
  if (input.channelActivity.type === "missing") {
    return { type: "reject", message: "No OpenCode session exists in this channel yet." };
  }
  if (input.channelActivity.activity.hasActiveRun) {
    return {
      type: "reject",
      message:
        "OpenCode is busy in this channel right now. Use /interrupt first or wait for the current run to finish.",
    };
  }
  return { type: "defer-and-check-health" };
};

export const decideCompactAfterHealthCheck = (
  healthy: boolean,
): { type: "reject-after-defer"; message: string } | { type: "start-compaction" } =>
  healthy
    ? { type: "start-compaction" }
    : {
        type: "reject-after-defer",
        message:
          "This channel session is unavailable right now. Send a normal message to recreate it.",
      };

export const decideInterruptEntry = (input: {
  inGuildTextChannel: boolean;
  channelActivity: ChannelActivity;
}): CommandRejection | { type: "defer-and-interrupt"; target: "run" | "compaction" } => {
  if (!input.inGuildTextChannel) {
    return { type: "reject", message: GUILD_TEXT_COMMAND_ONLY_MESSAGE };
  }
  if (input.channelActivity.type === "missing") {
    return { type: "reject", message: "No OpenCode session exists in this channel yet." };
  }
  if (input.channelActivity.activity.hasPendingQuestions) {
    return {
      type: "reject",
      message: QUESTION_PENDING_INTERRUPT_MESSAGE,
    };
  }
  if (input.channelActivity.activity.hasActiveRun) {
    return { type: "defer-and-interrupt", target: "run" };
  }
  if (input.channelActivity.activity.hasIdleCompaction) {
    return { type: "defer-and-interrupt", target: "compaction" };
  }
  return {
    type: "reject",
    message: "No active OpenCode run or compaction is running in this channel.",
  };
};

export const decideNewSessionEntry = (input: {
  inGuildTextChannel: boolean;
  channelActivity: ChannelActivity;
}): CommandRejection | { type: "defer-and-invalidate" } => {
  if (!input.inGuildTextChannel) {
    return { type: "reject", message: GUILD_TEXT_COMMAND_ONLY_MESSAGE };
  }
  if (input.channelActivity.type === "missing") {
    return { type: "defer-and-invalidate" };
  }
  if (input.channelActivity.activity.hasPendingQuestions) {
    return {
      type: "reject",
      message: QUESTION_PENDING_NEW_SESSION_MESSAGE,
    };
  }
  if (input.channelActivity.activity.hasActiveRun) {
    return {
      type: "reject",
      message:
        "OpenCode is busy in this channel right now. Wait for the current run to finish or use /interrupt before starting a fresh session.",
    };
  }
  if (input.channelActivity.activity.hasIdleCompaction) {
    return {
      type: "reject",
      message:
        "OpenCode is compacting this channel right now. Wait for compaction to finish or use /interrupt before starting a fresh session.",
    };
  }
  if (input.channelActivity.activity.hasQueuedWork) {
    return {
      type: "reject",
      message:
        "OpenCode still has queued work for this channel. Wait for it to finish before starting a fresh session.",
    };
  }
  if (input.channelActivity.activity.isBusy) {
    return {
      type: "reject",
      message: NEW_SESSION_BUSY_MESSAGE,
    };
  }
  return { type: "defer-and-invalidate" };
};

export const decideRunCompletion = (input: {
  transcript: string;
  questionOutcome: QuestionOutcome;
  interruptRequested: boolean;
}):
  | { type: "send-final-response" }
  | { type: "send-question-ui-failure"; message: string }
  | { type: "suppress-response" } => {
  if (input.transcript.trim()) {
    return { type: "send-final-response" };
  }
  if (input.questionOutcome._tag === "ui-failure" && !input.questionOutcome.notified) {
    return {
      type: "send-question-ui-failure",
      message: input.questionOutcome.message,
    };
  }
  if (input.interruptRequested || input.questionOutcome._tag === "user-rejected") {
    return { type: "suppress-response" };
  }
  return { type: "send-final-response" };
};
