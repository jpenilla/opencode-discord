import { Data, Effect, Option, Result } from "effect";
import { type SendableChannels } from "discord.js";

import { InfoCards } from "@/discord/info-card.ts";
import { IdleCompactionWorkflow } from "@/sessions/compaction/idle-compaction-workflow.ts";
import { OpencodeService } from "@/opencode/service.ts";
import { QuestionRuntime } from "@/sessions/question/question-runtime.ts";
import type { SessionRegistryState } from "@/sessions/session-runtime.ts";
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts";
import { formatError } from "@/util/errors.ts";
import { Logger } from "@/util/logging.ts";

const SHUTDOWN_RPC_TIMEOUT = "1 second";
const SHUTDOWN_GRACE_PERIOD = "10 seconds";
const SHUTDOWN_DRAIN_POLL_INTERVAL = "100 millis";

class SessionShutdownError extends Data.TaggedError("SessionShutdownError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const withShutdownRpcTimeout =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SessionShutdownError, R> =>
    effect.pipe(
      Effect.timeoutOption(SHUTDOWN_RPC_TIMEOUT),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(new SessionShutdownError({ message })),
      ),
    );

const warnAfterGraceTimeout = (
  effect: Effect.Effect<void, unknown>,
  onTimeout: () => Effect.Effect<void, unknown>,
) =>
  effect.pipe(
    Effect.timeoutOption(SHUTDOWN_GRACE_PERIOD),
    Effect.flatMap(
      Option.match({
        onSome: () => Effect.void,
        onNone: onTimeout,
      }),
    ),
  );

export const createSessionShutdown =
  (
    startShutdown: () => Effect.Effect<boolean, unknown>,
    getState: () => Effect.Effect<SessionRegistryState, unknown>,
    drainQueuedRunRequestsForShutdown: (session: ChannelSession) => Effect.Effect<void, unknown>,
    interruptSessionWorkers: () => Effect.Effect<void, unknown>,
    shutdownSessions: () => Effect.Effect<void, unknown>,
  ) =>
  () =>
    Effect.gen(function* () {
      const questionRuntime = yield* QuestionRuntime;
      const idleCompactionWorkflow = yield* IdleCompactionWorkflow;
      const opencode = yield* OpencodeService;
      const logger = yield* Logger;
      const infoCards = yield* InfoCards;
      const sessionFields = (session: ChannelSession) => ({
        channelId: session.channelId,
        sessionId: session.opencode.sessionId,
      });
      const shutdownQuestionSession = (session: ChannelSession) =>
        questionRuntime.shutdownSession(session.opencode.sessionId);

      const catchShutdownWarn =
        (message: string, context: (error: unknown) => Record<string, unknown> = () => ({})) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.catch((error) =>
              logger.warn(message, {
                ...context(error),
                error: formatError(error),
              }),
            ),
          );

      const forceCloseSessionHandle = (session: ChannelSession, reason: string) =>
        session.opencode.close().pipe(
          catchShutdownWarn("failed to force-close opencode session during shutdown", () => ({
            ...sessionFields(session),
            reason,
          })),
        );

      const interruptRunForShutdown = (session: ChannelSession, activeRun: ActiveRun) =>
        Effect.gen(function* () {
          activeRun.interruptRequested = true;
          activeRun.interruptSource = "shutdown";

          const result = yield* opencode
            .interruptSession(session.opencode)
            .pipe(
              withShutdownRpcTimeout("Timed out interrupting active run during shutdown"),
              Effect.result,
            );
          if (Result.isSuccess(result)) {
            return true;
          }

          yield* logger.warn("run interrupt was unresponsive during shutdown", {
            ...sessionFields(session),
            error: formatError(result.failure),
          });
          yield* forceCloseSessionHandle(session, "run interrupt timed out or failed");
          return false;
        });

      const awaitSessionIdleObservedAfterInterruptLoop = (
        sessionId: string,
      ): Effect.Effect<void, unknown> =>
        getState().pipe(
          Effect.flatMap((state) =>
            state.activeRunsBySessionId.has(sessionId)
              ? Effect.sleep(SHUTDOWN_DRAIN_POLL_INTERVAL).pipe(
                  Effect.andThen(awaitSessionIdleObservedAfterInterruptLoop(sessionId)),
                )
              : Effect.void,
          ),
        );

      const awaitSessionIdleObservedAfterInterrupt = (session: ChannelSession) =>
        warnAfterGraceTimeout(
          awaitSessionIdleObservedAfterInterruptLoop(session.opencode.sessionId),
          () =>
            logger.warn(
              "active run did not reach observed idle before question shutdown",
              sessionFields(session),
            ),
        );

      const interruptIdleCompactionForShutdown = (session: ChannelSession) =>
        idleCompactionWorkflow.requestInterrupt({ session }).pipe(
          withShutdownRpcTimeout("Timed out interrupting idle compaction during shutdown"),
          Effect.flatMap((result) =>
            result.type === "failed"
              ? Effect.fail(new SessionShutdownError({ message: result.message }))
              : Effect.void,
          ),
          Effect.catch((error) =>
            logger
              .warn("idle compaction interrupt was unresponsive during shutdown", {
                ...sessionFields(session),
                error: formatError(error),
              })
              .pipe(
                Effect.andThen(
                  forceCloseSessionHandle(session, "idle compaction interrupt timed out or failed"),
                ),
                Effect.andThen(
                  idleCompactionWorkflow
                    .handleInterrupted(session.opencode.sessionId)
                    .pipe(
                      catchShutdownWarn(
                        "failed to finalize idle compaction after forced shutdown",
                        () => sessionFields(session),
                      ),
                    ),
                ),
              ),
          ),
        );

      const requestSessionShutdown = (session: ChannelSession) =>
        Effect.gen(function* () {
          yield* drainQueuedRunRequestsForShutdown(session);

          if (session.activeRun) {
            const interrupted = yield* interruptRunForShutdown(session, session.activeRun);
            if (interrupted) {
              yield* awaitSessionIdleObservedAfterInterrupt(session);
            }
            yield* shutdownQuestionSession(session);
            return;
          }

          if (yield* idleCompactionWorkflow.hasActive(session.opencode.sessionId)) {
            yield* interruptIdleCompactionForShutdown(session);
          }
          yield* shutdownQuestionSession(session);
        });

      const readShutdownDrainState = () =>
        Effect.gen(function* () {
          const state = yield* getState();
          const hasActiveRuns = state.activeRunsBySessionId.size > 0;
          const sessionIds = [...state.sessionsBySessionId.keys()];
          const hasIdleCompactions =
            sessionIds.length === 0
              ? false
              : (yield* Effect.forEach(
                  sessionIds,
                  (sessionId) => idleCompactionWorkflow.hasActive(sessionId),
                  { concurrency: "unbounded", discard: false },
                )).some(Boolean);
          const hasPendingQuestions = yield* questionRuntime.hasPendingQuestionsAnywhere();

          return hasActiveRuns || hasIdleCompactions || hasPendingQuestions
            ? {
                hasActiveRuns,
                hasIdleCompactions,
                hasPendingQuestions,
              }
            : null;
        });

      const awaitShutdownDrainLoop = (): Effect.Effect<void, unknown> =>
        readShutdownDrainState().pipe(
          Effect.flatMap((drainState) =>
            drainState === null
              ? Effect.void
              : Effect.sleep(SHUTDOWN_DRAIN_POLL_INTERVAL).pipe(
                  Effect.andThen(awaitShutdownDrainLoop()),
                ),
          ),
        );

      const awaitShutdownDrain = () =>
        warnAfterGraceTimeout(awaitShutdownDrainLoop(), () =>
          readShutdownDrainState().pipe(
            Effect.flatMap((drainState) =>
              logger.warn("shutdown grace period elapsed before local work drained", {
                hasActiveRuns: drainState?.hasActiveRuns ?? false,
                hasIdleCompactions: drainState?.hasIdleCompactions ?? false,
                hasPendingQuestions: drainState?.hasPendingQuestions ?? false,
              }),
            ),
          ),
        );

      const finalizeShutdownCleanup = () =>
        Effect.gen(function* () {
          yield* questionRuntime
            .cleanupShutdownQuestions()
            .pipe(catchShutdownWarn("failed to finalize pending questions during shutdown"));

          const state = yield* getState();
          const activeRuns = [...state.activeRunsBySessionId.entries()];
          const idleCompactionSessionIds = (yield* Effect.forEach(
            state.sessionsBySessionId.keys(),
            (sessionId) =>
              idleCompactionWorkflow
                .hasActive(sessionId)
                .pipe(Effect.map((active) => (active ? sessionId : null))),
            { concurrency: "unbounded", discard: false },
          )).filter((sessionId): sessionId is string => sessionId !== null);

          yield* Effect.forEach(
            activeRuns,
            ([sessionId, activeRun]) =>
              Effect.gen(function* () {
                yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore);
                yield* activeRun
                  .finalizeProgress("interrupted")
                  .pipe(
                    catchShutdownWarn(
                      "failed to finalize interrupted run progress during shutdown",
                      () => ({ sessionId }),
                    ),
                  );
                yield* infoCards
                  .send(
                    activeRun.originMessage.channel as SendableChannels,
                    "🛑 Run interrupted",
                    "OpenCode stopped the active run in this channel because the bot is shutting down.",
                  )
                  .pipe(
                    catchShutdownWarn("failed to post shutdown interrupt info card", () => ({
                      channelId: activeRun.originMessage.channelId,
                      sessionId,
                    })),
                    Effect.ignore,
                  );
              }),
            { concurrency: "unbounded", discard: true },
          );

          yield* Effect.forEach(
            idleCompactionSessionIds,
            (sessionId) =>
              idleCompactionWorkflow.handleInterrupted(sessionId).pipe(
                catchShutdownWarn("failed to finalize idle compaction on shutdown", () => ({
                  sessionId,
                })),
              ),
            { concurrency: "unbounded", discard: true },
          );
        });

      return yield* startShutdown().pipe(
        Effect.flatMap((shouldRun) =>
          !shouldRun
            ? Effect.void
            : Effect.gen(function* () {
                yield* idleCompactionWorkflow
                  .shutdown()
                  .pipe(catchShutdownWarn("failed to begin idle compaction shutdown"));
                const state = yield* getState();
                yield* Effect.forEach(
                  [...state.sessionsBySessionId.values()],
                  requestSessionShutdown,
                  {
                    concurrency: "unbounded",
                    discard: true,
                  },
                );

                yield* awaitShutdownDrain();
                yield* finalizeShutdownCleanup();

                yield* interruptSessionWorkers().pipe(
                  catchShutdownWarn("failed to interrupt session workers on shutdown"),
                );
                yield* shutdownSessions().pipe(catchShutdownWarn("failed to shut down sessions"));
              }),
        ),
        Effect.catch((error) =>
          logger.warn("session orchestrator shutdown failed", {
            error: formatError(error),
          }),
        ),
      );
    });
