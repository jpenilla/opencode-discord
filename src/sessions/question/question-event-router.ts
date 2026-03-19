import type { Event, QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import { getEventByType } from "@/opencode/events.ts";

type QuestionWorkflowEvent =
  | { type: "asked"; sessionId: string; request: QuestionRequest }
  | {
      type: "replied";
      sessionId: string;
      requestId: string;
      answers: ReadonlyArray<QuestionAnswer>;
    }
  | { type: "rejected"; sessionId: string; requestId: string };

type QuestionEventRouterDeps = {
  sessionId: string;
  handleQuestionEvent: (event: QuestionWorkflowEvent) => Effect.Effect<void, unknown>;
};

export const routeQuestionEvent = (
  event: Event,
  deps: QuestionEventRouterDeps,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const questionAsked = getEventByType(event, "question.asked")?.properties ?? null;
    const questionReplied = getEventByType(event, "question.replied")?.properties ?? null;
    const questionRejected = getEventByType(event, "question.rejected")?.properties ?? null;

    if (questionAsked) {
      yield* deps.handleQuestionEvent({
        type: "asked",
        sessionId: deps.sessionId,
        request: questionAsked,
      });
    }
    if (questionReplied) {
      yield* deps.handleQuestionEvent({
        type: "replied",
        sessionId: deps.sessionId,
        requestId: questionReplied.requestID,
        answers: questionReplied.answers,
      });
    }
    if (questionRejected) {
      yield* deps.handleQuestionEvent({
        type: "rejected",
        sessionId: deps.sessionId,
        requestId: questionRejected.requestID,
      });
    }
  });
