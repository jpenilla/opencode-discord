import type {
  AssistantMessage,
  Event,
  QuestionAnswer,
  QuestionRequest,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Queue } from "effect";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import {
  getEventSessionId,
  getEventByType,
  getMessageUpdatedByRole,
  getUpdatedPartByType,
  isCompactionSummaryAssistant,
  isObservedAssistantMessage,
} from "@/opencode/events.ts";
import type { OpencodeServiceShape } from "@/opencode/service.ts";
import type { IdleCompactionWorkflowShape } from "@/sessions/idle-compaction-workflow.ts";
import {
  handleAssistantMessageUpdated,
  handleSessionError as failPendingPromptFromSessionError,
  handleSessionStatusUpdated,
  type PromptTrackingAction,
  handleUserMessageUpdated,
  resolvePromptTrackingActions,
} from "@/sessions/prompt-state.ts";
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts";
import type { RunProgressEvent } from "@/sessions/session.ts";
import type { LoggerShape } from "@/util/logging.ts";

export type EventHandler = {
  handleEvent: (event: Event) => Effect.Effect<void, unknown>;
};

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

type EventHandlerDeps = {
  getSessionContext: (
    sessionId: string,
  ) => Effect.Effect<{ session: ChannelSession; activeRun: ActiveRun | null } | null, unknown>;
  handleQuestionEvent: (
    event:
      | { type: "asked"; sessionId: string; request: QuestionRequest }
      | {
          type: "replied";
          sessionId: string;
          requestId: string;
          answers: ReadonlyArray<QuestionAnswer>;
        }
      | { type: "rejected"; sessionId: string; requestId: string },
  ) => Effect.Effect<void, unknown>;
  idleCompactionWorkflow: Pick<IdleCompactionWorkflowShape, "emitSummary" | "handleCompacted">;
  readPromptResult: OpencodeServiceShape["readPromptResult"];
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

export const createEventHandler = (deps: EventHandlerDeps): EventHandler => ({
  handleEvent: (event) =>
    Effect.gen(function* () {
      const sessionId = getEventSessionId(event);
      if (!sessionId) {
        return;
      }

      const context = yield* deps.getSessionContext(sessionId);
      if (!context) {
        return;
      }

      const { activeRun } = context;
      const progressEvent = toProgressEvent(event);
      const userMessage = getMessageUpdatedByRole(event, "user");
      const assistantMessage = getMessageUpdatedByRole(event, "assistant");
      const sessionError = getEventByType(event, "session.error")?.properties ?? null;
      const sessionStatus = getEventByType(event, "session.status")?.properties ?? null;
      const toolPart = getUpdatedPartByType(event, "tool");
      const questionAsked = getEventByType(event, "question.asked")?.properties ?? null;
      const questionReplied = getEventByType(event, "question.replied")?.properties ?? null;
      const questionRejected = getEventByType(event, "question.rejected")?.properties ?? null;

      if (questionAsked) {
        yield* deps.handleQuestionEvent({
          type: "asked",
          sessionId,
          request: questionAsked,
        });
      }
      if (questionReplied) {
        yield* deps.handleQuestionEvent({
          type: "replied",
          sessionId,
          requestId: questionReplied.requestID,
          answers: questionReplied.answers,
        });
      }
      if (questionRejected) {
        yield* deps.handleQuestionEvent({
          type: "rejected",
          sessionId,
          requestId: questionRejected.requestID,
        });
      }

      if (
        assistantMessage &&
        isCompactionSummaryAssistant(assistantMessage) &&
        isObservedAssistantMessage(assistantMessage)
      ) {
        yield* deps.idleCompactionWorkflow.emitSummary({
          session: context.session,
          messageId: assistantMessage.id,
        });
      }

      if (activeRun) {
        if (userMessage) {
          if (!isPreviousPromptMessage(activeRun, userMessage.id)) {
            recordCurrentPromptMessage(activeRun, userMessage.id);
            recordPromptUserMessage(activeRun, userMessage.id);
          }
        }

        if (assistantMessage) {
          if (!isPreviousPromptMessage(activeRun, assistantMessage.id)) {
            recordCurrentPromptMessage(activeRun, assistantMessage.id);
            recordPromptAssistantMessage(activeRun, assistantMessage);
          }
        }

        const relevantToolPart = toolPart ? selectToolPartForActiveRun(activeRun, toolPart) : null;
        const promptActions: PromptTrackingAction[] = [];

        if (userMessage && !isPreviousPromptMessage(activeRun, userMessage.id)) {
          promptActions.push(
            ...(yield* handleUserMessageUpdated(activeRun.promptState, userMessage)),
          );
        }

        if (assistantMessage && !isPreviousPromptMessage(activeRun, assistantMessage.id)) {
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
          yield* deps.readPromptResult(context.session.opencode, completePrompt.messageId).pipe(
            Effect.flatMap((result) =>
              Deferred.succeed(completePrompt.deferred, result).pipe(Effect.ignore),
            ),
            Effect.catch((error) =>
              deps.logger
                .warn("failed to resolve prompt result from event stream", {
                  channelId: context.session.channelId,
                  sessionId,
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
        return;
      }

      if (progressEvent?.type === "session-compacted") {
        yield* deps.idleCompactionWorkflow.handleCompacted(sessionId);
      }
    }),
});
