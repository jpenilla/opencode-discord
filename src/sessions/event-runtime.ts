import type { Event, QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { Deferred, Effect, Queue } from "effect"

import { compactionCardContent } from "@/discord/compaction-card.ts"
import {
  getAssistantMessageUpdated,
  getEventSessionId,
  getQuestionAsked,
  getQuestionRejected,
  getQuestionReplied,
  getSessionError,
  getSessionIdle,
  getSessionStatusUpdated,
  getToolPartUpdated,
} from "@/opencode/events.ts"
import type { OpencodeServiceShape } from "@/opencode/service.ts"
import {
  handleAssistantMessageUpdated,
  handleSessionError as handlePendingPromptSessionError,
  handleSessionIdle as handlePendingPromptSessionIdle,
  handleSessionStatusUpdated as handlePendingPromptSessionStatusUpdated,
  handleToolPartUpdated,
  resolvePromptTrackingActions,
  type PromptTrackingAction,
} from "@/sessions/prompt-state.ts"
import { collectProgressEvents } from "@/sessions/progress.ts"
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts"
import type { LoggerShape } from "@/util/logging.ts"

export type EventRuntime = {
  handleEvent: (event: Event) => Effect.Effect<void, unknown>
}

type EventRuntimeDeps = {
  getSessionContext: (sessionId: string) => Effect.Effect<{ session: ChannelSession; activeRun: ActiveRun | null } | null, unknown>
  handleQuestionEvent: (
    event:
      | { type: "asked"; sessionId: string; request: QuestionRequest }
      | { type: "replied"; sessionId: string; requestId: string; answers: ReadonlyArray<QuestionAnswer> }
      | { type: "rejected"; sessionId: string; requestId: string },
  ) => Effect.Effect<void, unknown>
  finalizeIdleCompactionCard: (sessionId: string, title: string, body: string) => Effect.Effect<void, unknown>
  readPromptResult: OpencodeServiceShape["readPromptResult"]
  logger: LoggerShape
  formatError: (error: unknown) => string
}

export const createEventRuntime = (deps: EventRuntimeDeps): EventRuntime => ({
  handleEvent: (event) =>
    Effect.gen(function* () {
      const sessionId = getEventSessionId(event)
      if (!sessionId) {
        return
      }

      const context = yield* deps.getSessionContext(sessionId)
      if (!context) {
        return
      }

      const { activeRun } = context
      const progressEvents = collectProgressEvents(event)
      const assistantMessage = getAssistantMessageUpdated(event)
      const sessionStatus = getSessionStatusUpdated(event)
      const sessionIdle = getSessionIdle(event)
      const sessionError = getSessionError(event)
      const toolPart = getToolPartUpdated(event)
      const questionAsked = getQuestionAsked(event)
      const questionReplied = getQuestionReplied(event)
      const questionRejected = getQuestionRejected(event)

      if (questionAsked) {
        yield* deps.handleQuestionEvent({
          type: "asked",
          sessionId,
          request: questionAsked,
        })
      }
      if (questionReplied) {
        yield* deps.handleQuestionEvent({
          type: "replied",
          sessionId,
          requestId: questionReplied.requestID,
          answers: questionReplied.answers,
        })
      }
      if (questionRejected) {
        yield* deps.handleQuestionEvent({
          type: "rejected",
          sessionId,
          requestId: questionRejected.requestID,
        })
      }

      if (activeRun) {
        const promptActions: PromptTrackingAction[] = [
          ...(assistantMessage ? yield* handleAssistantMessageUpdated(activeRun.promptState, assistantMessage) : []),
          ...(sessionStatus ? yield* handlePendingPromptSessionStatusUpdated(activeRun.promptState, sessionStatus.status) : []),
          ...(sessionIdle ? yield* handlePendingPromptSessionIdle(activeRun.promptState) : []),
          ...(sessionError ? yield* handlePendingPromptSessionError(activeRun.promptState, sessionError.error) : []),
          ...(toolPart ? yield* handleToolPartUpdated(activeRun.promptState, toolPart) : []),
        ]

        yield* Effect.forEach(progressEvents, (progressEvent) =>
          Queue.offer(activeRun.progressQueue, progressEvent).pipe(Effect.asVoid),
        ).pipe(Effect.asVoid)

        const resolvedActions = resolvePromptTrackingActions(promptActions)

        yield* Effect.forEach(
          resolvedActions.compactionSummaryMessageIds,
          (messageId) =>
            deps.readPromptResult(context.session.opencode, messageId).pipe(
              Effect.flatMap((result) => {
                const text = result.transcript.trim()
                if (!text) {
                  return Effect.void
                }
                return Queue.offer(activeRun.progressQueue, {
                  type: "compaction-summary",
                  text,
                }).pipe(Effect.asVoid)
              }),
              Effect.catchAll((error) =>
                deps.logger.warn("failed to load compaction summary transcript", {
                  channelId: context.session.channelId,
                  sessionId,
                  messageId,
                  error: deps.formatError(error),
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        )

        if (resolvedActions.completePrompt) {
          yield* deps.readPromptResult(context.session.opencode, resolvedActions.completePrompt.messageId).pipe(
            Effect.flatMap((result) =>
              Deferred.succeed(resolvedActions.completePrompt!.deferred, result).pipe(Effect.ignore),
            ),
            Effect.catchAll((error) =>
              deps.logger.warn("failed to resolve prompt result from event stream", {
                channelId: context.session.channelId,
                sessionId,
                messageId: resolvedActions.completePrompt!.messageId,
                error: deps.formatError(error),
              }).pipe(
                Effect.zipRight(Deferred.fail(resolvedActions.completePrompt!.deferred, error).pipe(Effect.ignore)),
              )),
          )
        }

        if (resolvedActions.failPrompt) {
          yield* Deferred.fail(resolvedActions.failPrompt.deferred, resolvedActions.failPrompt.error).pipe(Effect.ignore)
        }
        return
      }

      if (progressEvents.some((progressEvent) => progressEvent.type === "session-compacted")) {
        const compactedCard = compactionCardContent("compacted")
        yield* deps.finalizeIdleCompactionCard(
          sessionId,
          compactedCard.title,
          compactedCard.body,
        )
      }
    }),
})
