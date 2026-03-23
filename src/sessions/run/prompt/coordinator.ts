import { Data, Deferred, Effect, Queue, Ref } from "effect";

import type { PromptResult, SessionHandle, OpencodeServiceShape } from "@/opencode/service.ts";
import {
  readRunInterrupt,
  resetPromptTracking,
  setCurrentPromptContext,
} from "@/sessions/run/active-state.ts";
import { beginPendingPrompt, failPendingPrompt } from "@/sessions/run/prompt/state.ts";
import type { AdmittedPromptContext } from "@/sessions/run/prompt/context.ts";
import {
  admitRequestBatchToActiveRun,
  type NonEmptyRunRequestBatch,
} from "@/sessions/run/batch.ts";
import { type ActiveRun } from "@/sessions/types.ts";
import type { LoggerShape } from "@/util/logging.ts";

class PromptInterruptedError extends Data.TaggedError("PromptInterruptedError")<{
  readonly message: string;
}> {}

type PromptCoordinatorActiveRun = Pick<
  ActiveRun,
  | "attachmentMessagesById"
  | "currentPromptContext"
  | "interruptRequested"
  | "interruptSource"
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
  awaitIdleCompaction: () => Effect.Effect<void, unknown>;
  submitPrompt: OpencodeServiceShape["submitPrompt"];
  handlePromptCompleted: (
    promptContext: AdmittedPromptContext,
    result: PromptResult,
  ) => Effect.Effect<void, unknown>;
  logger: LoggerShape;
};

const drainQueuedFollowUps = (
  activeRun: Pick<ActiveRun, "followUpQueue" | "acceptFollowUps">,
): Effect.Effect<NonEmptyRunRequestBatch | null> =>
  Effect.gen(function* () {
    yield* Ref.set(activeRun.acceptFollowUps, false);
    const followUps = yield* Queue.clear(activeRun.followUpQueue);
    return followUps.length > 0 ? [followUps[0]!, ...followUps.slice(1)] : null;
  });

export const coordinateActiveRunPrompts = (
  input: ActiveRunPromptCoordinatorInput,
): Effect.Effect<PromptResult, unknown> =>
  Effect.gen(function* () {
    const runPrompt = (promptContext: AdmittedPromptContext) =>
      Effect.gen(function* () {
        if (readRunInterrupt(input.activeRun).requested) {
          return yield* new PromptInterruptedError({ message: "interrupted" });
        }

        resetPromptTracking(input.activeRun);
        setCurrentPromptContext(input.activeRun, promptContext);
        const completion = yield* beginPendingPrompt(input.activeRun.promptState);

        yield* input
          .submitPrompt(input.session, promptContext.prompt)
          .pipe(
            Effect.catch((error) =>
              failPendingPrompt(input.activeRun.promptState, error).pipe(
                Effect.andThen(Effect.fail(error)),
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
    yield* input.awaitIdleCompaction();
    let result = yield* runPrompt(initialPrompt);
    yield* input.handlePromptCompleted(initialPrompt, result);

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
      yield* input.handlePromptCompleted(followUpPrompt, result);
    }

    return result;
  });
