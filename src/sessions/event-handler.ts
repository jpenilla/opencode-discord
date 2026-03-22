import type { Event } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import {
  getEventByType,
  getEventSessionId,
  getMessageUpdatedByRole,
  isCompactionSummaryAssistant,
  isObservedAssistantMessage,
} from "@/opencode/events.ts";
import { OpencodeService } from "@/opencode/service.ts";
import { IdleCompactionWorkflow } from "@/sessions/compaction/idle-compaction-workflow.ts";
import {
  QuestionRuntime,
  QuestionSessionLookup,
  type QuestionRuntimeShape,
} from "@/sessions/question/question-runtime.ts";
import { routeRunEvent } from "@/sessions/run/run-event-router.ts";
import { Logger } from "@/util/logging.ts";

const routeQuestionEvent = (
  event: Event,
  sessionId: string,
  handleQuestionEvent: QuestionRuntimeShape["handleEvent"],
) =>
  Effect.gen(function* () {
    const questionAsked = getEventByType(event, "question.asked")?.properties ?? null;
    const questionReplied = getEventByType(event, "question.replied")?.properties ?? null;
    const questionRejected = getEventByType(event, "question.rejected")?.properties ?? null;

    if (questionAsked) {
      yield* handleQuestionEvent({
        type: "asked",
        sessionId,
        request: questionAsked,
      });
    }
    if (questionReplied) {
      yield* handleQuestionEvent({
        type: "replied",
        sessionId,
        requestId: questionReplied.requestID,
        answers: questionReplied.answers,
      });
    }
    if (questionRejected) {
      yield* handleQuestionEvent({
        type: "rejected",
        sessionId,
        requestId: questionRejected.requestID,
      });
    }
  });

export const makeSessionEventHandler: Effect.Effect<
  { handleEvent: (event: Event) => Effect.Effect<void, unknown> },
  unknown,
  IdleCompactionWorkflow | Logger | OpencodeService | QuestionRuntime | QuestionSessionLookup
> = Effect.gen(function* () {
  const idleCompactionWorkflow = yield* IdleCompactionWorkflow;
  const logger = yield* Logger;
  const opencode = yield* OpencodeService;
  const questions = yield* QuestionRuntime;
  const { getSessionContext } = yield* QuestionSessionLookup;

  return {
    handleEvent: (event) =>
      Effect.gen(function* () {
        const sessionId = getEventSessionId(event);
        if (!sessionId) {
          return;
        }

        const context = yield* getSessionContext(sessionId);
        if (!context) {
          return;
        }

        yield* routeQuestionEvent(event, sessionId, questions.handleEvent);

        const assistantMessage = getMessageUpdatedByRole(event, "assistant");
        if (
          assistantMessage &&
          isCompactionSummaryAssistant(assistantMessage) &&
          isObservedAssistantMessage(assistantMessage)
        ) {
          yield* idleCompactionWorkflow.emitSummary({
            session: context.session,
            messageId: assistantMessage.id,
          });
        }

        if (!context.activeRun && getEventByType(event, "session.compacted")?.properties) {
          yield* idleCompactionWorkflow.handleCompacted(sessionId);
        }

        if (!context.activeRun) {
          return;
        }

        yield* routeRunEvent(event, context.session, context.activeRun).pipe(
          Effect.provideService(OpencodeService, opencode),
          Effect.provideService(Logger, logger),
        );
      }),
  };
});
