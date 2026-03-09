import type { Event, QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { Effect, Queue } from "effect"

import { compactionCardContent } from "@/discord/compaction-card.ts"
import {
  getEventSessionId,
  getQuestionAsked,
  getQuestionRejected,
  getQuestionReplied,
} from "@/opencode/events.ts"
import { collectProgressEvents } from "@/sessions/progress.ts"
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts"

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
  updateIdleCompactionCard: (sessionId: string, title: string, body: string) => Effect.Effect<void, unknown>
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
        yield* Effect.forEach(progressEvents, (progressEvent) =>
          Queue.offer(activeRun.progressQueue, progressEvent).pipe(Effect.asVoid),
        ).pipe(Effect.asVoid)
        return
      }

      if (progressEvents.some((progressEvent) => progressEvent.type === "session-compacted")) {
        const compactedCard = compactionCardContent("compacted")
        yield* deps.updateIdleCompactionCard(
          sessionId,
          compactedCard.title,
          compactedCard.body,
        )
      }
    }),
})
