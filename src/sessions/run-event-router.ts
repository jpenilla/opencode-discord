import type { AssistantMessage, Event, ToolPart } from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Queue } from "effect";

import {
  getEventByType,
  getMessageUpdatedByRole,
  getUpdatedPartByType,
  isCompactionSummaryAssistant,
} from "@/opencode/events.ts";
import type { OpencodeServiceShape } from "@/opencode/service.ts";
import {
  handleAssistantMessageUpdated,
  handleSessionError as failPendingPromptFromSessionError,
  handleSessionStatusUpdated,
  type PromptTrackingAction,
  handleUserMessageUpdated,
  resolvePromptTrackingActions,
} from "@/sessions/prompt-state.ts";
import type { ActiveRun, ChannelSession, RunProgressEvent } from "@/sessions/session.ts";
import type { LoggerShape } from "@/util/logging.ts";

const recordPromptUserMessage = (activeRun: ActiveRun, userMessageId: string) => {
  activeRun.currentPromptUserMessageId = userMessageId;
};

const isPreviousPromptMessage = (activeRun: ActiveRun, messageId: string) =>
  activeRun.previousPromptMessageIds.has(messageId);

const recordCurrentPromptMessage = (activeRun: ActiveRun, messageId: string) => {
  activeRun.currentPromptMessageIds.add(messageId);
};

const recordPromptAssistantMessage = (activeRun: ActiveRun, message: AssistantMessage) => {
  if (isCompactionSummaryAssistant(message)) {
    return;
  }

  activeRun.assistantMessageParentIds.set(message.id, message.parentID);
};

const assistantBelongsToCurrentPrompt = (activeRun: ActiveRun, assistantMessageId: string) => {
  if (activeRun.currentPromptUserMessageId === null) {
    return false;
  }

  const parentId = activeRun.assistantMessageParentIds.get(assistantMessageId);
  if (parentId === undefined) {
    return false;
  }

  return parentId === activeRun.currentPromptUserMessageId;
};

const isInFlightToolPart = (status: ToolPart["state"]["status"]) =>
  status === "pending" || status === "running";

const selectToolPartForActiveRun = (activeRun: ActiveRun, toolPart: ToolPart) => {
  const belongsToCurrentPrompt = assistantBelongsToCurrentPrompt(activeRun, toolPart.messageID);
  const isObservedCall = activeRun.observedToolCallIds.has(toolPart.callID);
  const isInFlight = isInFlightToolPart(toolPart.state.status);

  if (!belongsToCurrentPrompt && !isObservedCall && !isInFlight) {
    return null;
  }

  activeRun.observedToolCallIds.add(toolPart.callID);
  return toolPart;
};

const toProgressEvent = (event: Event): RunProgressEvent | null => {
  const toolPart = getUpdatedPartByType(event, "tool");
  if (toolPart) {
    return {
      type: "tool-updated",
      part: toolPart,
    };
  }

  const patchPart = getUpdatedPartByType(event, "patch");
  if (patchPart) {
    return {
      type: "patch-updated",
      part: patchPart,
    };
  }

  const sessionStatus = getEventByType(event, "session.status")?.properties;
  if (sessionStatus) {
    return {
      type: "session-status",
      status: sessionStatus.status,
    };
  }

  const compactionPart = getUpdatedPartByType(event, "compaction");
  if (compactionPart) {
    return {
      type: "session-compacting",
      part: compactionPart,
    };
  }

  const compacted = getEventByType(event, "session.compacted")?.properties;
  if (compacted) {
    return {
      type: "session-compacted",
      compacted,
    };
  }

  const reasoningPart = getUpdatedPartByType(event, "reasoning");
  if (reasoningPart?.time.end) {
    return {
      type: "reasoning-completed",
      partId: reasoningPart.id,
      text: reasoningPart.text,
    };
  }

  return null;
};

type RunEventRouterDeps = {
  sessionId: string;
  session: ChannelSession;
  activeRun: ActiveRun;
  readPromptResult: OpencodeServiceShape["readPromptResult"];
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

export const routeRunEvent = (
  event: Event,
  deps: RunEventRouterDeps,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const progressEvent = toProgressEvent(event);
    const userMessage = getMessageUpdatedByRole(event, "user");
    const assistantMessage = getMessageUpdatedByRole(event, "assistant");
    const sessionError = getEventByType(event, "session.error")?.properties ?? null;
    const sessionStatus = getEventByType(event, "session.status")?.properties ?? null;
    const toolPart = getUpdatedPartByType(event, "tool");

    if (userMessage) {
      if (!isPreviousPromptMessage(deps.activeRun, userMessage.id)) {
        recordCurrentPromptMessage(deps.activeRun, userMessage.id);
        recordPromptUserMessage(deps.activeRun, userMessage.id);
      }
    }

    if (assistantMessage) {
      if (!isPreviousPromptMessage(deps.activeRun, assistantMessage.id)) {
        recordCurrentPromptMessage(deps.activeRun, assistantMessage.id);
        recordPromptAssistantMessage(deps.activeRun, assistantMessage);
      }
    }

    const relevantToolPart = toolPart ? selectToolPartForActiveRun(deps.activeRun, toolPart) : null;
    const promptActions: PromptTrackingAction[] = [];

    if (userMessage && !isPreviousPromptMessage(deps.activeRun, userMessage.id)) {
      promptActions.push(
        ...(yield* handleUserMessageUpdated(deps.activeRun.promptState, userMessage)),
      );
    }

    if (assistantMessage && !isPreviousPromptMessage(deps.activeRun, assistantMessage.id)) {
      promptActions.push(
        ...(yield* handleAssistantMessageUpdated(deps.activeRun.promptState, assistantMessage)),
      );
    }

    if (sessionError) {
      promptActions.push(
        ...(yield* failPendingPromptFromSessionError(
          deps.activeRun.promptState,
          sessionError.error ?? new Error("OpenCode session failed"),
        )),
      );
    }

    if (sessionStatus) {
      promptActions.push(
        ...(yield* handleSessionStatusUpdated(deps.activeRun.promptState, sessionStatus.status)),
      );
    }

    // OpenCode may emit terminal tool updates while pruning stored tool output for older
    // assistant messages. Tool correlation here is only for the progress/UI stream: terminal
    // updates are accepted once the call is already live in this prompt or the prompt's user
    // message has been bound to the assistant lineage. Pending/running updates are still
    // surfaced immediately so live tool activity is not hidden while the current prompt is
    // still being correlated.
    const runProgressEvent =
      progressEvent?.type === "tool-updated" && !relevantToolPart ? null : progressEvent;
    if (runProgressEvent) {
      yield* Queue.offer(deps.activeRun.progressQueue, runProgressEvent).pipe(Effect.asVoid);
    }

    const { completePrompt, failPrompt } = resolvePromptTrackingActions(promptActions);

    if (completePrompt) {
      yield* deps.readPromptResult(deps.session.opencode, completePrompt.messageId).pipe(
        Effect.flatMap((result) =>
          Deferred.succeed(completePrompt.deferred, result).pipe(Effect.ignore),
        ),
        Effect.catch((error) =>
          deps.logger
            .warn("failed to resolve prompt result from event stream", {
              channelId: deps.session.channelId,
              sessionId: deps.sessionId,
              messageId: completePrompt.messageId,
              error: deps.formatError(error),
            })
            .pipe(
              Effect.andThen(Deferred.fail(completePrompt.deferred, error).pipe(Effect.ignore)),
            ),
        ),
      );
    }

    if (failPrompt) {
      yield* Deferred.fail(failPrompt.deferred, failPrompt.error).pipe(Effect.ignore);
    }
  });
