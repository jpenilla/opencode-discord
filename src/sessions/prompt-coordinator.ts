import { Chunk, Effect, Queue, Ref } from "effect"

import type { PromptResult, SessionHandle, OpencodeServiceShape } from "@/opencode/service.ts"
import { admitRequestBatchToActiveRun, type NonEmptyRunRequestBatch } from "@/sessions/run-batch.ts"
import type { ActiveRun } from "@/sessions/session.ts"
import type { LoggerShape } from "@/util/logging.ts"

type PromptCoordinatorActiveRun = Pick<ActiveRun, "attachmentMessagesById" | "followUpQueue" | "acceptFollowUps">

export type ActiveRunPromptCoordinatorInput = {
  channelId: string
  session: SessionHandle
  activeRun: PromptCoordinatorActiveRun
  initialRequests: NonEmptyRunRequestBatch
  prompt: OpencodeServiceShape["prompt"]
  logger: LoggerShape
}

const drainQueuedFollowUps = (
  activeRun: Pick<ActiveRun, "followUpQueue" | "acceptFollowUps">,
): Effect.Effect<NonEmptyRunRequestBatch | null> =>
  Effect.gen(function* () {
    yield* Ref.set(activeRun.acceptFollowUps, false)
    const followUps = yield* Queue.takeAll(activeRun.followUpQueue).pipe(Effect.map(Chunk.toReadonlyArray))
    return followUps.length > 0 ? (followUps as NonEmptyRunRequestBatch) : null
  })

export const coordinateActiveRunPrompts = (input: ActiveRunPromptCoordinatorInput): Effect.Effect<PromptResult, unknown> =>
  Effect.gen(function* () {
    const initialPrompt = admitRequestBatchToActiveRun(
      input.activeRun.attachmentMessagesById,
      input.initialRequests,
      "initial",
    )
    let result = yield* input.prompt(input.session, initialPrompt)

    while (true) {
      const followUpBatch = yield* drainQueuedFollowUps(input.activeRun)
      if (!followUpBatch) {
        break
      }

      yield* input.logger.info("absorbing queued follow-up messages into active run", {
        channelId: input.channelId,
        sessionId: input.session.sessionId,
        count: followUpBatch.length,
      })

      const followUpPrompt = admitRequestBatchToActiveRun(
        input.activeRun.attachmentMessagesById,
        followUpBatch,
        "follow-up",
      )
      yield* Ref.set(input.activeRun.acceptFollowUps, true)
      result = yield* input.prompt(input.session, followUpPrompt)
    }

    return result
  })
