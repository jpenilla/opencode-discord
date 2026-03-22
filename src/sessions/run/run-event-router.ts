import type { AssistantMessage, Event, ToolPart } from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Queue } from "effect";

import {
  getEventByType,
  getMessageUpdatedByRole,
  getUpdatedPartByType,
  isCompactionSummaryAssistant,
} from "@/opencode/events.ts";
import { OpencodeService } from "@/opencode/service.ts";
import {
  handleAssistantMessageUpdated,
  handleSessionError as failPendingPromptFromSessionError,
  handleSessionStatusUpdated,
  handleUserMessageUpdated,
  resolvePromptTrackingActions,
} from "@/sessions/run/prompt-state.ts";
import type { ActiveRun, ChannelSession, RunProgressEvent } from "@/sessions/session.ts";
import { formatError } from "@/util/errors.ts";
import { Logger } from "@/util/logging.ts";

const isPreviousPromptMessage = (activeRun: ActiveRun, messageId: string) =>
  activeRun.previousPromptMessageIds.has(messageId);

const recordPromptAssistantMessage = (activeRun: ActiveRun, message: AssistantMessage) => {
  if (isCompactionSummaryAssistant(message)) {
    return;
  }

  activeRun.assistantMessageParentIds.set(message.id, message.parentID);
};

const assistantBelongsToCurrentPrompt = (activeRun: ActiveRun, assistantMessageId: string) =>
  activeRun.currentPromptUserMessageId !== null &&
  activeRun.assistantMessageParentIds.get(assistantMessageId) ===
    activeRun.currentPromptUserMessageId;

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

export const routeRunEvent = (event: Event, session: ChannelSession, activeRun: ActiveRun) =>
  Effect.gen(function* () {
    const opencode = yield* OpencodeService;
    const logger = yield* Logger;
    const progressEvent = toProgressEvent(event);
    const userMessage = getMessageUpdatedByRole(event, "user");
    const assistantMessage = getMessageUpdatedByRole(event, "assistant");
    const sessionError = getEventByType(event, "session.error")?.properties ?? null;
    const sessionStatus = getEventByType(event, "session.status")?.properties ?? null;
    const toolPart = getUpdatedPartByType(event, "tool");
    const isNewUserMessage = userMessage && !isPreviousPromptMessage(activeRun, userMessage.id);
    const isNewAssistantMessage =
      assistantMessage && !isPreviousPromptMessage(activeRun, assistantMessage.id);

    if (isNewUserMessage) {
      activeRun.currentPromptMessageIds.add(userMessage.id);
      activeRun.currentPromptUserMessageId = userMessage.id;
    }

    if (isNewAssistantMessage) {
      activeRun.currentPromptMessageIds.add(assistantMessage.id);
      recordPromptAssistantMessage(activeRun, assistantMessage);
    }

    const relevantToolPart = toolPart ? selectToolPartForActiveRun(activeRun, toolPart) : null;
    const promptActions = [];

    if (isNewUserMessage) {
      promptActions.push(...(yield* handleUserMessageUpdated(activeRun.promptState, userMessage)));
    }

    if (isNewAssistantMessage) {
      promptActions.push(
        ...(yield* handleAssistantMessageUpdated(activeRun.promptState, assistantMessage)),
      );
    }

    if (sessionError) {
      promptActions.push(
        ...(yield* failPendingPromptFromSessionError(
          activeRun.promptState,
          sessionError.error ?? new Error("OpenCode session failed"),
        )),
      );
    }

    if (sessionStatus) {
      promptActions.push(
        ...(yield* handleSessionStatusUpdated(activeRun.promptState, sessionStatus.status)),
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
      yield* Queue.offer(activeRun.progressQueue, runProgressEvent).pipe(Effect.asVoid);
    }

    const { completePrompt, failPrompt } = resolvePromptTrackingActions(promptActions);

    if (completePrompt) {
      yield* opencode.readPromptResult(session.opencode, completePrompt.messageId).pipe(
        Effect.flatMap((result) =>
          Deferred.succeed(completePrompt.deferred, result).pipe(Effect.ignore),
        ),
        Effect.catch((error) =>
          logger
            .warn("failed to resolve prompt result from event stream", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              messageId: completePrompt.messageId,
              error: formatError(error),
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
