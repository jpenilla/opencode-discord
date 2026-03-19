import type { Event } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import {
  getEventByType,
  getMessageUpdatedByRole,
  isCompactionSummaryAssistant,
  isObservedAssistantMessage,
} from "@/opencode/events.ts";
import type { IdleCompactionWorkflowShape } from "@/sessions/compaction/idle-compaction-workflow.ts";
import type { ChannelSession } from "@/sessions/session.ts";

type CompactionEventRouterDeps = {
  sessionId: string;
  session: ChannelSession;
  hasActiveRun: boolean;
  idleCompactionWorkflow: Pick<IdleCompactionWorkflowShape, "emitSummary" | "handleCompacted">;
};

export const routeCompactionEvent = (
  event: Event,
  deps: CompactionEventRouterDeps,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const assistantMessage = getMessageUpdatedByRole(event, "assistant");
    if (
      assistantMessage &&
      isCompactionSummaryAssistant(assistantMessage) &&
      isObservedAssistantMessage(assistantMessage)
    ) {
      yield* deps.idleCompactionWorkflow.emitSummary({
        session: deps.session,
        messageId: assistantMessage.id,
      });
    }

    if (deps.hasActiveRun) {
      return;
    }

    const compacted = getEventByType(event, "session.compacted")?.properties ?? null;
    if (compacted) {
      yield* deps.idleCompactionWorkflow.handleCompacted(deps.sessionId);
    }
  });
