import type { Message } from "discord.js";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import type { Effect, Queue, Ref } from "effect";

import type { TypingLoop } from "@/discord/messages.ts";
import type { AdmittedPromptContext } from "@/sessions/run/prompt/context.ts";
import type { PendingPrompt } from "@/sessions/run/prompt/state.ts";
import type {
  ActiveRun,
  QuestionOutcome,
  RunFinalizationReason,
  RunInterruptSource,
  RunProgressEvent,
  RunRequest,
} from "@/sessions/types.ts";
import { noQuestionOutcome } from "@/sessions/types.ts";

export const createActiveRun = (input: {
  originMessage: Message;
  workdir: string;
  progressQueue: Queue.Queue<RunProgressEvent>;
  promptState: Ref.Ref<PendingPrompt | null>;
  followUpQueue: Queue.Queue<RunRequest>;
  acceptFollowUps: Ref.Ref<boolean>;
  typing: TypingLoop;
  finalizeProgress: (reason?: RunFinalizationReason) => Effect.Effect<void, unknown>;
}): ActiveRun => ({
  originMessage: input.originMessage,
  workdir: input.workdir,
  attachmentMessagesById: new Map<string, Message>(),
  currentPromptContext: null,
  previousPromptMessageIds: new Set<string>(),
  currentPromptMessageIds: new Set<string>(),
  currentPromptUserMessageId: null,
  assistantMessageParentIds: new Map<string, string>(),
  observedToolCallIds: new Set<string>(),
  progressQueue: input.progressQueue,
  promptState: input.promptState,
  followUpQueue: input.followUpQueue,
  acceptFollowUps: input.acceptFollowUps,
  typing: input.typing,
  finalizeProgress: input.finalizeProgress,
  questionWorkflow: null,
  questionOutcome: noQuestionOutcome(),
  interruptRequested: false,
  interruptSource: null,
});

export const currentPromptReplyTargetMessage = (
  activeRun: Pick<ActiveRun, "currentPromptContext" | "originMessage">,
) => activeRun.currentPromptContext?.replyTargetMessage ?? activeRun.originMessage;

export const readRunInterrupt = (
  activeRun: Pick<ActiveRun, "interruptRequested" | "interruptSource">,
) => ({
  requested: activeRun.interruptRequested,
  source: activeRun.interruptSource,
});

export const requestRunInterrupt = (activeRun: ActiveRun, source: RunInterruptSource) => {
  activeRun.interruptRequested = true;
  activeRun.interruptSource = source;
};

export const clearRunInterrupt = (activeRun: ActiveRun) => {
  activeRun.interruptRequested = false;
  activeRun.interruptSource = null;
};

export const setRunQuestionOutcome = (activeRun: ActiveRun, outcome: QuestionOutcome) => {
  activeRun.questionOutcome = outcome;
};

export const setRunQuestionWorkflow = (
  activeRun: ActiveRun,
  workflow: ActiveRun["questionWorkflow"],
) => {
  activeRun.questionWorkflow = workflow;
};

export const readRunQuestionOutcome = (activeRun: ActiveRun) => activeRun.questionOutcome;

export const clearRunQuestionOutcome = (activeRun: ActiveRun) => {
  activeRun.questionOutcome = noQuestionOutcome();
};

export const setCurrentPromptContext = (
  activeRun: Pick<ActiveRun, "currentPromptContext">,
  promptContext: AdmittedPromptContext,
) => {
  activeRun.currentPromptContext = promptContext;
};

export const resetPromptTracking = (
  activeRun: Pick<
    ActiveRun,
    | "previousPromptMessageIds"
    | "currentPromptMessageIds"
    | "currentPromptUserMessageId"
    | "assistantMessageParentIds"
    | "observedToolCallIds"
  >,
) => {
  activeRun.previousPromptMessageIds = activeRun.currentPromptMessageIds;
  activeRun.currentPromptMessageIds = new Set<string>();
  activeRun.currentPromptUserMessageId = null;
  activeRun.assistantMessageParentIds.clear();
  activeRun.observedToolCallIds.clear();
};

export const isPreviousPromptMessage = (activeRun: ActiveRun, messageId: string) =>
  activeRun.previousPromptMessageIds.has(messageId);

export const recordPromptUserMessage = (activeRun: ActiveRun, messageId: string) => {
  activeRun.currentPromptMessageIds.add(messageId);
  activeRun.currentPromptUserMessageId = messageId;
};

export const recordPromptAssistantMessage = (
  activeRun: ActiveRun,
  input: {
    messageId: string;
    parentId: string;
  },
) => {
  activeRun.currentPromptMessageIds.add(input.messageId);
  activeRun.assistantMessageParentIds.set(input.messageId, input.parentId);
};

export const assistantBelongsToCurrentPrompt = (activeRun: ActiveRun, assistantMessageId: string) =>
  activeRun.currentPromptUserMessageId !== null &&
  activeRun.assistantMessageParentIds.get(assistantMessageId) ===
    activeRun.currentPromptUserMessageId;

export const hasObservedToolCall = (activeRun: ActiveRun, callId: string) =>
  activeRun.observedToolCallIds.has(callId);

export const observeToolCall = (activeRun: ActiveRun, callId: string) => {
  activeRun.observedToolCallIds.add(callId);
};

export const selectToolPartForActiveRun = (activeRun: ActiveRun, toolPart: ToolPart) => {
  const belongsToCurrentPrompt = assistantBelongsToCurrentPrompt(activeRun, toolPart.messageID);
  const isObservedCall = hasObservedToolCall(activeRun, toolPart.callID);
  const isInFlight = toolPart.state.status === "pending" || toolPart.state.status === "running";

  if (!belongsToCurrentPrompt && !isObservedCall && !isInFlight) {
    return null;
  }

  observeToolCall(activeRun, toolPart.callID);
  return toolPart;
};
