import { Effect, Queue, Ref } from "effect";

import type { ActiveRun, ChannelSession, RunRequest } from "@/sessions/session.ts";

export type RunRequestDestination = "session" | "follow-up";
type EnqueueableSession = {
  queue: ChannelSession["queue"];
  activeRun: Pick<ActiveRun, "followUpQueue" | "acceptFollowUps"> | null;
};

export const enqueueRunRequest = (
  session: EnqueueableSession,
  request: RunRequest,
): Effect.Effect<RunRequestDestination> =>
  Effect.gen(function* () {
    if (session.activeRun) {
      const acceptFollowUps = yield* Ref.get(session.activeRun.acceptFollowUps);
      if (acceptFollowUps) {
        yield* Queue.offer(session.activeRun.followUpQueue, request);
        return "follow-up" as const;
      }
    }

    yield* Queue.offer(session.queue, request);
    return "session" as const;
  });
