import type { Event } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import { getEventSessionId } from "@/opencode/events.ts";
import type { OpencodeServiceShape } from "@/opencode/service.ts";
import { routeCompactionEvent } from "@/sessions/compaction/compaction-event-router.ts";
import type { IdleCompactionWorkflowShape } from "@/sessions/compaction/idle-compaction-workflow.ts";
import {
  routeQuestionEvent,
  type QuestionWorkflowEvent,
} from "@/sessions/question/question-runtime.ts";
import { routeRunEvent } from "@/sessions/run/run-event-router.ts";
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts";
import type { LoggerShape } from "@/util/logging.ts";

export type EventHandler = {
  handleEvent: (event: Event) => Effect.Effect<void, unknown>;
};

type EventHandlerDeps = {
  getSessionContext: (
    sessionId: string,
  ) => Effect.Effect<{ session: ChannelSession; activeRun: ActiveRun | null } | null, unknown>;
  handleQuestionEvent: (event: QuestionWorkflowEvent) => Effect.Effect<void, unknown>;
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

      yield* routeQuestionEvent(event, {
        sessionId,
        handleQuestionEvent: deps.handleQuestionEvent,
      });
      yield* routeCompactionEvent(event, {
        sessionId,
        session: context.session,
        hasActiveRun: Boolean(context.activeRun),
        idleCompactionWorkflow: deps.idleCompactionWorkflow,
      });

      if (!context.activeRun) {
        return;
      }

      yield* routeRunEvent(event, {
        sessionId,
        session: context.session,
        activeRun: context.activeRun,
        readPromptResult: deps.readPromptResult,
        logger: deps.logger,
        formatError: deps.formatError,
      });
    }),
});
