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
import type { QuestionWorkflowEvent } from "@/sessions/question/question-workflow-types.ts";
import { routeRunEvent } from "@/sessions/run/run-event-router.ts";
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts";
import { Logger } from "@/util/logging.ts";

const routeQuestionEvent = (
  event: Event,
  handleQuestionEvent: (event: QuestionWorkflowEvent) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const sessionId = getEventSessionId(event);
    if (!sessionId) {
      return;
    }

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

export const routeLoadedSessionEvent = (
  event: Event,
  session: ChannelSession,
  activeRun: ActiveRun | null,
) =>
  Effect.gen(function* () {
    const logger = yield* Logger;
    const opencode = yield* OpencodeService;

    if (activeRun?.questionWorkflow) {
      yield* routeQuestionEvent(event, activeRun.questionWorkflow.handleEvent);
    }

    const assistantMessage = getMessageUpdatedByRole(event, "assistant");
    if (
      assistantMessage &&
      isCompactionSummaryAssistant(assistantMessage) &&
      isObservedAssistantMessage(assistantMessage)
    ) {
      yield* session.compactionWorkflow.emitSummary(assistantMessage.id);
    }

    if (!activeRun && getEventByType(event, "session.compacted")?.properties) {
      yield* session.compactionWorkflow.handleCompacted();
    }

    if (!activeRun) {
      return;
    }

    yield* routeRunEvent(event, session, activeRun).pipe(
      Effect.provideService(OpencodeService, opencode),
      Effect.provideService(Logger, logger),
    );
  });
