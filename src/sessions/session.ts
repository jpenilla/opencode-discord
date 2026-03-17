import type { Message, SendableChannels } from "discord.js";
import type {
  CompactionPart,
  EventSessionCompacted,
  PatchPart,
  SessionStatus,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import type { Effect } from "effect";
import type { Deferred } from "effect/Deferred";
import type { Queue } from "effect/Queue";
import type { Ref } from "effect/Ref";

import type { TypingLoop } from "@/discord/messages.ts";
import type { SessionHandle } from "@/opencode/service.ts";
import type { AdmittedPromptContext } from "@/sessions/prompt-context.ts";
import type { ChannelSettings } from "@/state/channel-settings.ts";
import type { PendingPrompt } from "@/sessions/prompt-state.ts";

export type SessionCreateSpec = {
  workdir: string;
  title: string;
  systemPromptAppend?: string;
};

export type RunRequest = {
  message: Message;
  prompt: string;
  attachmentMessages: ReadonlyArray<Message>;
};

export type QuestionOutcome =
  | { _tag: "none" }
  | { _tag: "user-rejected" }
  | { _tag: "ui-failure"; message: string; notified: boolean };

export const noQuestionOutcome = (): QuestionOutcome => ({ _tag: "none" });
export const questionUiFailureOutcome = (message: string, notified = false): QuestionOutcome => ({
  _tag: "ui-failure",
  message,
  notified,
});

export type RunInterruptSource = "user" | "shutdown";

export type RunFinalizationReason = "interrupted" | "shutdown";

export type ActiveRun = {
  originMessage: Message;
  workdir: string;
  attachmentMessagesById: Map<string, Message>;
  currentPromptContext: AdmittedPromptContext | null;
  previousPromptMessageIds: Set<string>;
  currentPromptMessageIds: Set<string>;
  currentPromptUserMessageId: string | null;
  assistantMessageParentIds: Map<string, string>;
  observedToolCallIds: Set<string>;
  progressQueue: Queue<RunProgressEvent>;
  promptState: Ref<PendingPrompt | null>;
  followUpQueue: Queue<RunRequest>;
  acceptFollowUps: Ref<boolean>;
  typing: TypingLoop;
  finalizeProgress: (reason?: RunFinalizationReason) => Effect.Effect<void, unknown>;
  questionOutcome: QuestionOutcome;
  interruptRequested: boolean;
  interruptSource: RunInterruptSource | null;
};

export const currentPromptReplyTargetMessage = (
  activeRun: Pick<ActiveRun, "currentPromptContext" | "originMessage">,
) => activeRun.currentPromptContext?.replyTargetMessage ?? activeRun.originMessage;

export type RunProgressEvent =
  | { type: "run-finalizing"; ack: Deferred<void>; reason?: RunFinalizationReason }
  | { type: "patch-updated"; part: PatchPart }
  | { type: "reasoning-completed"; partId: string; text: string }
  | { type: "session-compacting"; part: CompactionPart }
  | { type: "session-compacted"; compacted: EventSessionCompacted["properties"] }
  | { type: "session-status"; status: SessionStatus }
  | { type: "tool-updated"; part: ToolPart };

export type ChannelSession = {
  channelId: string;
  opencode: SessionHandle;
  systemPromptAppend?: string;
  rootDir: string;
  workdir: string;
  createdAt: number;
  lastActivityAt: number;
  channelSettings: ChannelSettings;
  progressChannel: SendableChannels | null;
  progressMentionContext: Message | null;
  emittedCompactionSummaryMessageIds: Set<string>;
  queue: Queue<RunRequest>;
  activeRun: ActiveRun | null;
};

export const resetActivePromptTracking = (
  activeRun: Pick<
    ActiveRun,
    | "previousPromptMessageIds"
    | "currentPromptMessageIds"
    | "currentPromptUserMessageId"
    | "assistantMessageParentIds"
    | "observedToolCallIds"
  >,
) => {
  // Keep only the prompt that just finished as the ignore window so the next prompt binds to its
  // own message lineage without carrying unbounded history forward.
  activeRun.previousPromptMessageIds = activeRun.currentPromptMessageIds;
  activeRun.currentPromptMessageIds = new Set<string>();
  activeRun.currentPromptUserMessageId = null;
  activeRun.assistantMessageParentIds.clear();
  activeRun.observedToolCallIds.clear();
};

export const buildSessionCreateSpec = (input: {
  channelId: string;
  workdir: string;
  systemPromptAppend?: string;
}): SessionCreateSpec => ({
  workdir: input.workdir,
  title: `Discord #${input.channelId}`,
  systemPromptAppend: input.systemPromptAppend,
});
