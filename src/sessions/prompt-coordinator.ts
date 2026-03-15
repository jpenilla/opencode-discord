import { Chunk, Deferred, Effect, Queue, Ref } from "effect";

import type { PromptResult, SessionHandle, OpencodeServiceShape } from "@/opencode/service.ts";
import { beginPendingPrompt, failPendingPrompt } from "@/sessions/prompt-state.ts";
import {
  admitRequestBatchToActiveRun,
  type NonEmptyRunRequestBatch,
} from "@/sessions/run-batch.ts";
import { resetActivePromptTracking, type ActiveRun } from "@/sessions/session.ts";
import type { LoggerShape } from "@/util/logging.ts";

type PromptCoordinatorActiveRun = Pick<
  ActiveRun,
  | "attachmentMessagesById"
  | "previousPromptMessageIds"
  | "currentPromptMessageIds"
  | "promptState"
  | "followUpQueue"
  | "acceptFollowUps"
  | "currentPromptUserMessageId"
  | "assistantMessageParentIds"
  | "observedToolCallIds"
>;

export type ActiveRunPromptCoordinatorInput = {
  channelId: string;
  session: SessionHandle;
  activeRun: PromptCoordinatorActiveRun;
  initialRequests: NonEmptyRunRequestBatch;
  awaitIdleCompaction: (sessionId: string) => Effect.Effect<void, unknown>;
  submitPrompt: OpencodeServiceShape["submitPrompt"];
  logger: LoggerShape;
};

const drainQueuedFollowUps = (
  activeRun: Pick<ActiveRun, "followUpQueue" | "acceptFollowUps">,
): Effect.Effect<NonEmptyRunRequestBatch | null> =>
  Effect.gen(function* () {
    yield* Ref.set(activeRun.acceptFollowUps, false);
    const followUps = yield* Queue.takeAll(activeRun.followUpQueue).pipe(
      Effect.map(Chunk.toReadonlyArray),
    );
    return followUps.length > 0 ? (followUps as NonEmptyRunRequestBatch) : null;
  });

export const coordinateActiveRunPrompts = (
  input: ActiveRunPromptCoordinatorInput,
): Effect.Effect<PromptResult, unknown> =>
  Effect.gen(function* () {
    const runPrompt = (value: string) =>
      Effect.gen(function* () {
        resetActivePromptTracking(input.activeRun);
        const completion = yield* beginPendingPrompt(input.activeRun.promptState);

        yield* input
          .submitPrompt(input.session, value)
          .pipe(
            Effect.catchAll((error) =>
              failPendingPrompt(input.activeRun.promptState, error).pipe(
                Effect.zipRight(Effect.fail(error)),
              ),
            ),
          );

        return yield* Deferred.await(completion);
      });

    const initialPrompt = admitRequestBatchToActiveRun(
      input.activeRun.attachmentMessagesById,
      input.initialRequests,
      "initial",
    );
    yield* input.awaitIdleCompaction(input.session.sessionId);
    let result = yield* runPrompt(initialPrompt);

    while (true) {
      const followUpBatch = yield* drainQueuedFollowUps(input.activeRun);
      if (!followUpBatch) {
        break;
      }

      yield* input.logger.info("absorbing queued follow-up messages into active run", {
        channelId: input.channelId,
        sessionId: input.session.sessionId,
        count: followUpBatch.length,
      });

      const followUpPrompt = admitRequestBatchToActiveRun(
        input.activeRun.attachmentMessagesById,
        followUpBatch,
        "follow-up",
      );
      yield* Ref.set(input.activeRun.acceptFollowUps, true);
      result = yield* runPrompt(followUpPrompt);
    }

    return result;
  });
