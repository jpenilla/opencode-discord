import type { Event, QuestionAnswer, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Queue } from "effect";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import {
  getAssistantMessageUpdated,
  getEventSessionId,
  getQuestionAsked,
  getQuestionRejected,
  getQuestionReplied,
  isCompactionSummaryAssistant,
  isObservedAssistantMessage,
  getSessionError,
  getToolPartUpdated,
  getUserMessageUpdated,
} from "@/opencode/events.ts";
import type { OpencodeServiceShape } from "@/opencode/service.ts";
import {
  handleAssistantMessageUpdated,
  handleSessionError as failPendingPromptFromSessionError,
  handleUserMessageUpdated,
  resolvePromptTrackingActions,
} from "@/sessions/prompt-state.ts";
import { collectProgressEvents } from "@/sessions/progress.ts";
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts";
import type { LoggerShape } from "@/util/logging.ts";

export type EventRuntime = {
  handleEvent: (event: Event) => Effect.Effect<void, unknown>;
};

const recordPromptUserMessage = (activeRun: ActiveRun, userMessageId: string) => {
  activeRun.currentPromptUserMessageId = userMessageId;
};

const recordPromptAssistantMessage = (
  activeRun: ActiveRun,
  message: NonNullable<ReturnType<typeof getAssistantMessageUpdated>>,
) => {
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

const selectToolPartForActiveRun = (
  activeRun: ActiveRun,
  toolPart: NonNullable<ReturnType<typeof getToolPartUpdated>>,
) => {
  const belongsToCurrentPrompt = assistantBelongsToCurrentPrompt(activeRun, toolPart.messageID);
  const isObservedCall = activeRun.observedToolCallIds.has(toolPart.callID);
  const isInFlight = isInFlightToolPart(toolPart.state.status);

  if (!belongsToCurrentPrompt && !isObservedCall && !isInFlight) {
    return null;
  }

  activeRun.observedToolCallIds.add(toolPart.callID);
  return toolPart;
};

type EventRuntimeDeps = {
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
  finalizeIdleCompactionCard: (
    sessionId: string,
    title: string,
    body: string,
  ) => Effect.Effect<void, unknown>;
  sendCompactionSummary: (session: ChannelSession, text: string) => Effect.Effect<void, unknown>;
  readPromptResult: OpencodeServiceShape["readPromptResult"];
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

export const createEventRuntime = (deps: EventRuntimeDeps): EventRuntime => ({
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
      const progressEvents = collectProgressEvents(event);
      const userMessage = getUserMessageUpdated(event);
      const assistantMessage = getAssistantMessageUpdated(event);
      const sessionError = getSessionError(event);
      const toolPart = getToolPartUpdated(event);
      const questionAsked = getQuestionAsked(event);
      const questionReplied = getQuestionReplied(event);
      const questionRejected = getQuestionRejected(event);

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

      const emitCompactionSummary = (targetSession: ChannelSession, messageId: string) => {
        if (targetSession.emittedCompactionSummaryMessageIds.has(messageId)) {
          return Effect.void;
        }

        if (!targetSession.channelSettings.showCompactionSummaries) {
          return Effect.sync(() => {
            targetSession.emittedCompactionSummaryMessageIds.add(messageId);
          });
        }

        return deps.readPromptResult(targetSession.opencode, messageId).pipe(
          Effect.flatMap((result) => {
            const text = result.transcript.trim();
            if (!text) {
              return Effect.void;
            }

            targetSession.emittedCompactionSummaryMessageIds.add(messageId);
            return deps.sendCompactionSummary(targetSession, text);
          }),
          Effect.catchAll((error) =>
            deps.logger.warn("failed to load compaction summary transcript", {
              channelId: targetSession.channelId,
              sessionId,
              messageId,
              error: deps.formatError(error),
            }),
          ),
        );
      };

      if (
        assistantMessage &&
        isCompactionSummaryAssistant(assistantMessage) &&
        isObservedAssistantMessage(assistantMessage)
      ) {
        yield* emitCompactionSummary(context.session, assistantMessage.id);
      }

      if (activeRun) {
        if (userMessage) {
          recordPromptUserMessage(activeRun, userMessage.id);
        }

        if (assistantMessage) {
          recordPromptAssistantMessage(activeRun, assistantMessage);
        }

        const relevantToolPart = toolPart ? selectToolPartForActiveRun(activeRun, toolPart) : null;
        const promptActions = [];

        if (userMessage) {
          promptActions.push(
            ...(yield* handleUserMessageUpdated(activeRun.promptState, userMessage)),
          );
        }

        if (assistantMessage) {
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

        // OpenCode may emit terminal tool updates while pruning stored tool output for older
        // assistant messages. Tool correlation here is only for the progress/UI stream: terminal
        // updates are accepted once the call is already live in this prompt or the prompt's user
        // message has been bound to the assistant lineage. Pending/running updates are still
        // surfaced immediately so live tool activity is not hidden while the current prompt is
        // still being correlated.
        const runProgressEvents = relevantToolPart
          ? progressEvents
          : progressEvents.filter((progressEvent) => progressEvent.type !== "tool-updated");
        yield* Effect.forEach(
          runProgressEvents,
          (progressEvent) =>
            Queue.offer(activeRun.progressQueue, progressEvent).pipe(Effect.asVoid),
          { discard: true },
        );

        const { completePrompt, failPrompt } = resolvePromptTrackingActions(promptActions);

        if (completePrompt) {
          yield* deps.readPromptResult(context.session.opencode, completePrompt.messageId).pipe(
            Effect.flatMap((result) =>
              Deferred.succeed(completePrompt.deferred, result).pipe(Effect.ignore),
            ),
            Effect.catchAll((error) =>
              deps.logger
                .warn("failed to resolve prompt result from event stream", {
                  channelId: context.session.channelId,
                  sessionId,
                  messageId: completePrompt.messageId,
                  error: deps.formatError(error),
                })
                .pipe(
                  Effect.zipRight(
                    Deferred.fail(completePrompt.deferred, error).pipe(Effect.ignore),
                  ),
                ),
            ),
          );
        }

        if (failPrompt) {
          yield* Deferred.fail(failPrompt.deferred, failPrompt.error).pipe(Effect.ignore);
        }
        return;
      }

      if (progressEvents.some((progressEvent) => progressEvent.type === "session-compacted")) {
        const compactedCard = compactionCardContent("compacted");
        yield* deps.finalizeIdleCompactionCard(sessionId, compactedCard.title, compactedCard.body);
      }
    }),
});
