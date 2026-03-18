import { Effect, Option } from "effect";
import { type SendableChannels } from "discord.js";

import type { InfoCardsShape } from "@/discord/info-cards.ts";
import type { IdleCompactionWorkflowShape } from "@/sessions/idle-compaction-workflow.ts";
import type { OpencodeServiceShape } from "@/opencode/service.ts";
import type { QuestionRuntime } from "@/sessions/question-runtime.ts";
import type { SessionLifecycleState } from "@/sessions/session-runtime.ts";
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts";
import type { LoggerShape } from "@/util/logging.ts";

const SHUTDOWN_RPC_TIMEOUT = "1 second";
const SHUTDOWN_GRACE_PERIOD = "10 seconds";
const SHUTDOWN_DRAIN_POLL_INTERVAL = "100 millis";

type SessionShutdownDeps = {
  startShutdown: () => Effect.Effect<boolean>;
  getState: () => Effect.Effect<SessionLifecycleState>;
  questionRuntime: Pick<
    QuestionRuntime,
    "shutdownSession" | "cleanupShutdownQuestions" | "hasPendingQuestionsAnywhere"
  >;
  idleCompactionWorkflow: Pick<
    IdleCompactionWorkflowShape,
    "hasActive" | "requestInterrupt" | "handleInterrupted" | "shutdown"
  >;
  opencode: Pick<OpencodeServiceShape, "interruptSession">;
  logger: LoggerShape;
  infoCards: InfoCardsShape;
  drainQueuedRunRequestsForShutdown: (session: ChannelSession) => Effect.Effect<void, unknown>;
  interruptSessionWorkers: () => Effect.Effect<void, unknown>;
  shutdownSessions: () => Effect.Effect<void, unknown>;
  formatError: (error: unknown) => string;
};

const withShutdownRpcTimeout =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Error, R> =>
    effect.pipe(
      Effect.timeoutOption(SHUTDOWN_RPC_TIMEOUT),
      Effect.flatMap((result) =>
        Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(new Error(message)),
      ),
    );

const forceCloseSessionHandle = (
  deps: Pick<SessionShutdownDeps, "logger" | "formatError">,
  session: ChannelSession,
  reason: string,
) =>
  session.opencode.close().pipe(
    Effect.catch((error) =>
      deps.logger.warn("failed to force-close opencode session during shutdown", {
        channelId: session.channelId,
        sessionId: session.opencode.sessionId,
        reason,
        error: deps.formatError(error),
      }),
    ),
  );

const interruptRunForShutdown = (
  deps: SessionShutdownDeps,
  session: ChannelSession,
  activeRun: ActiveRun,
) =>
  Effect.gen(function* () {
    activeRun.interruptRequested = true;
    activeRun.interruptSource = "shutdown";

    const result = yield* deps.opencode
      .interruptSession(session.opencode)
      .pipe(
        withShutdownRpcTimeout("Timed out interrupting active run during shutdown"),
        Effect.result,
      );
    if (result._tag === "Success") {
      return true;
    }

    yield* deps.logger.warn("run interrupt was unresponsive during shutdown", {
      channelId: session.channelId,
      sessionId: session.opencode.sessionId,
      error: deps.formatError(result.failure),
    });
    yield* forceCloseSessionHandle(deps, session, "run interrupt timed out or failed");
    return false;
  });

const awaitSessionIdleObservedAfterInterruptLoop = (
  deps: SessionShutdownDeps,
  sessionId: string,
): Effect.Effect<void, unknown> =>
  deps
    .getState()
    .pipe(
      Effect.flatMap((state) =>
        state.activeRunsBySessionId.has(sessionId)
          ? Effect.sleep(SHUTDOWN_DRAIN_POLL_INTERVAL).pipe(
              Effect.andThen(awaitSessionIdleObservedAfterInterruptLoop(deps, sessionId)),
            )
          : Effect.void,
      ),
    );

const awaitSessionIdleObservedAfterInterrupt = (
  deps: SessionShutdownDeps,
  session: ChannelSession,
) =>
  awaitSessionIdleObservedAfterInterruptLoop(deps, session.opencode.sessionId).pipe(
    Effect.timeoutOption(SHUTDOWN_GRACE_PERIOD),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.void
        : deps.logger.warn("active run did not reach observed idle before question shutdown", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
          }),
    ),
  );

const interruptIdleCompactionForShutdown = (deps: SessionShutdownDeps, session: ChannelSession) =>
  deps.idleCompactionWorkflow.requestInterrupt({ session }).pipe(
    withShutdownRpcTimeout("Timed out interrupting idle compaction during shutdown"),
    Effect.flatMap((result) =>
      result.type === "failed" ? Effect.fail(new Error(result.message)) : Effect.void,
    ),
    Effect.catch((error) =>
      deps.logger
        .warn("idle compaction interrupt was unresponsive during shutdown", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          error: deps.formatError(error),
        })
        .pipe(
          Effect.andThen(
            forceCloseSessionHandle(deps, session, "idle compaction interrupt timed out or failed"),
          ),
          Effect.andThen(
            deps.idleCompactionWorkflow.handleInterrupted(session.opencode.sessionId).pipe(
              Effect.catch((finalizeError) =>
                deps.logger.warn("failed to finalize idle compaction after forced shutdown", {
                  channelId: session.channelId,
                  sessionId: session.opencode.sessionId,
                  error: deps.formatError(finalizeError),
                }),
              ),
            ),
          ),
        ),
    ),
  );

const requestSessionShutdown = (deps: SessionShutdownDeps, session: ChannelSession) =>
  Effect.gen(function* () {
    yield* deps.drainQueuedRunRequestsForShutdown(session);

    if (session.activeRun) {
      const interrupted = yield* interruptRunForShutdown(deps, session, session.activeRun);
      if (interrupted) {
        yield* awaitSessionIdleObservedAfterInterrupt(deps, session);
      }
      yield* deps.questionRuntime.shutdownSession(session.opencode.sessionId);
      return;
    }

    if (yield* deps.idleCompactionWorkflow.hasActive(session.opencode.sessionId)) {
      yield* interruptIdleCompactionForShutdown(deps, session);
      yield* deps.questionRuntime.shutdownSession(session.opencode.sessionId);
      return;
    }

    yield* deps.questionRuntime.shutdownSession(session.opencode.sessionId);
  });

const readShutdownDrainState = (deps: SessionShutdownDeps) =>
  Effect.gen(function* () {
    const state = yield* deps.getState();
    const hasActiveRuns = state.activeRunsBySessionId.size > 0;
    const sessionIds = [...state.sessionsBySessionId.keys()];
    const hasIdleCompactions =
      sessionIds.length === 0
        ? false
        : (yield* Effect.forEach(
            sessionIds,
            (sessionId) => deps.idleCompactionWorkflow.hasActive(sessionId),
            { concurrency: "unbounded", discard: false },
          )).some(Boolean);
    const hasPendingQuestions = yield* deps.questionRuntime.hasPendingQuestionsAnywhere();

    if (hasActiveRuns || hasIdleCompactions || hasPendingQuestions) {
      return {
        hasActiveRuns,
        hasIdleCompactions,
        hasPendingQuestions,
      } as const;
    }
    return null;
  });

const awaitShutdownDrainLoop = (deps: SessionShutdownDeps): Effect.Effect<void, unknown> =>
  readShutdownDrainState(deps).pipe(
    Effect.flatMap((drainState) =>
      drainState === null
        ? Effect.void
        : Effect.sleep(SHUTDOWN_DRAIN_POLL_INTERVAL).pipe(
            Effect.andThen(awaitShutdownDrainLoop(deps)),
          ),
    ),
  );

const awaitShutdownDrain = (deps: SessionShutdownDeps) =>
  awaitShutdownDrainLoop(deps).pipe(
    Effect.timeoutOption(SHUTDOWN_GRACE_PERIOD),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.void
        : readShutdownDrainState(deps).pipe(
            Effect.flatMap((drainState) =>
              deps.logger.warn("shutdown grace period elapsed before local work drained", {
                hasActiveRuns: drainState?.hasActiveRuns ?? false,
                hasIdleCompactions: drainState?.hasIdleCompactions ?? false,
                hasPendingQuestions: drainState?.hasPendingQuestions ?? false,
              }),
            ),
          ),
    ),
  );

const finalizeShutdownCleanup = (deps: SessionShutdownDeps) =>
  Effect.gen(function* () {
    yield* deps.questionRuntime.cleanupShutdownQuestions().pipe(
      Effect.catch((error) =>
        deps.logger.warn("failed to finalize pending questions during shutdown", {
          error: deps.formatError(error),
        }),
      ),
    );

    const state = yield* deps.getState();
    const activeRuns = [...state.activeRunsBySessionId.entries()];
    const idleCompactionSessionIds = (yield* Effect.forEach(
      state.sessionsBySessionId.keys(),
      (sessionId) =>
        deps.idleCompactionWorkflow
          .hasActive(sessionId)
          .pipe(Effect.map((active) => (active ? sessionId : null))),
      { concurrency: "unbounded", discard: false },
    )).filter((sessionId): sessionId is string => sessionId !== null);

    yield* Effect.forEach(
      activeRuns,
      ([sessionId, activeRun]) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore);
          yield* activeRun.finalizeProgress("interrupted").pipe(
            Effect.catch((error) =>
              deps.logger.warn("failed to finalize interrupted run progress during shutdown", {
                sessionId,
                error: deps.formatError(error),
              }),
            ),
          );
          yield* deps.infoCards
            .send(
              activeRun.originMessage.channel as SendableChannels,
              "🛑 Run interrupted",
              "OpenCode stopped the active run in this channel because the bot is shutting down.",
            )
            .pipe(
              Effect.catch((error) =>
                deps.logger.warn("failed to post shutdown interrupt info card", {
                  channelId: activeRun.originMessage.channelId,
                  sessionId,
                  error: deps.formatError(error),
                }),
              ),
              Effect.ignore,
            );
        }),
      { concurrency: "unbounded", discard: true },
    );

    yield* Effect.forEach(
      idleCompactionSessionIds,
      (sessionId) =>
        deps.idleCompactionWorkflow.handleInterrupted(sessionId).pipe(
          Effect.catch((error) =>
            deps.logger.warn("failed to finalize idle compaction on shutdown", {
              sessionId,
              error: deps.formatError(error),
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

export const createSessionShutdown =
  (deps: SessionShutdownDeps) => (): Effect.Effect<void, unknown> =>
    deps.startShutdown().pipe(
      Effect.flatMap((shouldRun) =>
        !shouldRun
          ? Effect.void
          : Effect.gen(function* () {
              yield* deps.idleCompactionWorkflow.shutdown().pipe(
                Effect.catch((error) =>
                  deps.logger.warn("failed to begin idle compaction shutdown", {
                    error: deps.formatError(error),
                  }),
                ),
              );
              const state = yield* deps.getState();
              const sessions = [...state.sessionsBySessionId.values()];
              yield* Effect.forEach(sessions, (session) => requestSessionShutdown(deps, session), {
                concurrency: "unbounded",
                discard: true,
              });

              yield* awaitShutdownDrain(deps);
              yield* finalizeShutdownCleanup(deps);

              yield* deps.interruptSessionWorkers().pipe(
                Effect.catch((error) =>
                  deps.logger.warn("failed to interrupt session workers on shutdown", {
                    error: deps.formatError(error),
                  }),
                ),
              );
              yield* deps.shutdownSessions().pipe(
                Effect.catch((error) =>
                  deps.logger.warn("failed to shut down sessions", {
                    error: deps.formatError(error),
                  }),
                ),
              );
            }),
      ),
      Effect.catch((error) =>
        deps.logger.warn("session orchestrator shutdown failed", {
          error: deps.formatError(error),
        }),
      ),
    );
