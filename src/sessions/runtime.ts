import type { Interaction, Message, SendableChannels } from "discord.js";
import {
  Effect,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Result,
  ServiceMap,
} from "effect";

import { AppConfig } from "@/config.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards } from "@/discord/info-card.ts";
import { parseQuestionActionId, questionInteractionReply } from "@/discord/question-card.ts";
import { getEventSessionId, OpencodeEventQueue } from "@/opencode/events.ts";
import { OpencodeService } from "@/opencode/service.ts";
import {
  type SessionCompactionInterruptResult,
  type SessionCompactionStartResult,
  makeSessionCompactionWorkflow,
} from "@/sessions/compaction/workflow.ts";
import { type ChannelActivity, type SessionActivity } from "@/sessions/loaded/activity.ts";
import { buildLoadedSessionDirectory } from "@/sessions/loaded/directory.ts";
import { routeLoadedSessionEvent } from "@/sessions/loaded/event-router.ts";
import type { LoadedSessionHandle } from "@/sessions/loaded/handle.ts";
import { makeQuestionRuntime, QuestionRuntime } from "@/sessions/question/runtime.ts";
import { type RunRequestDestination } from "@/sessions/request-routing.ts";
import { makeSessionRegistry } from "@/sessions/registry.ts";
import { makeRunOrchestrator, RunSessionLifecycle } from "@/sessions/run/run-executor.ts";
import { clearRunInterrupt, requestRunInterrupt } from "@/sessions/run/active-state.ts";
import { takeQueuedRunBatch } from "@/sessions/run/batch.ts";
import { type ActiveRun, type ChannelSession, type RunRequest } from "@/sessions/types.ts";
import { SessionStoreLayer } from "@/sessions/store.ts";
import { type ChannelSettings } from "@/state/channel-settings.ts";
import { formatError } from "@/util/errors.ts";
import { Logger } from "@/util/logging.ts";

type FsEnv = FileSystem.FileSystem | Path.Path;

export type QueuedMessageRunRequest = {
  sessionId: string;
  destination: RunRequestDestination;
};

export type RunInterruptRequestResult =
  | { type: "requested" }
  | { type: "question-pending" }
  | { type: "failed"; error: unknown };

export type SessionActivityLookupMode = "loaded" | "restored";

const SHUTDOWN_RPC_TIMEOUT = "1 second";
const SHUTDOWN_GRACE_PERIOD = "10 seconds";
const SHUTDOWN_DRAIN_POLL_INTERVAL = "100 millis";

const withShutdownRpcTimeout =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | string, R> =>
    effect.pipe(
      Effect.timeoutOption(SHUTDOWN_RPC_TIMEOUT),
      Effect.flatMap((result) =>
        Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(message),
      ),
    );

const warnAfterGraceTimeout = (
  effect: Effect.Effect<void, unknown>,
  onTimeout: () => Effect.Effect<void, unknown>,
) =>
  effect.pipe(
    Effect.timeoutOption(SHUTDOWN_GRACE_PERIOD),
    Effect.flatMap(Option.match({ onSome: () => Effect.void, onNone: onTimeout })),
  );

export type SessionRuntimeShape = {
  activity: {
    readChannel: (
      channelId: string,
      mode: SessionActivityLookupMode,
    ) => Effect.Effect<ChannelActivity, unknown, FsEnv>;
  };
  runs: {
    getActiveBySessionId: (sessionId: string) => Effect.Effect<ActiveRun | null, unknown>;
    queueMessage: (
      message: Message,
      request: RunRequest,
      reason: string,
    ) => Effect.Effect<QueuedMessageRunRequest, unknown, FsEnv>;
    requestInterrupt: (
      channelId: string,
    ) => Effect.Effect<RunInterruptRequestResult, unknown, FsEnv>;
  };
  questions: {
    routeInteraction: (interaction: Interaction) => Effect.Effect<void, unknown>;
  };
  channels: {
    invalidate: (channelId: string, reason: string) => Effect.Effect<boolean, unknown>;
    updateLoadedSettings: (
      channelId: string,
      settings: ChannelSettings,
    ) => Effect.Effect<void, unknown>;
  };
  compaction: {
    start: (
      channelId: string,
      channel: SendableChannels,
    ) => Effect.Effect<SessionCompactionStartResult, unknown, FsEnv>;
    requestInterrupt: (
      channelId: string,
    ) => Effect.Effect<SessionCompactionInterruptResult, unknown, FsEnv>;
  };
  shutdown: () => Effect.Effect<void, unknown>;
};

export class SessionRuntime extends ServiceMap.Service<SessionRuntime, SessionRuntimeShape>()(
  "SessionRuntime",
) {}

export const SessionRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const logger = yield* Logger;
    const config = yield* AppConfig;
    const infoCards = yield* InfoCards;
    const opencode = yield* OpencodeService;
    const eventQueue = yield* OpencodeEventQueue;
    const shutdownStartedRef = yield* Ref.make(false);
    const fiberSet = yield* FiberSet.make();
    const loadedSessions = yield* buildLoadedSessionDirectory();

    const sendQuestionUiFailure = (message: Message, error: unknown) =>
      Effect.promise(() =>
        message.reply({
          content: formatErrorResponse("## ❌ Failed to show questions", formatError(error)),
          allowedMentions: { repliedUser: false, parse: [] },
        }),
      );

    const serviceLayer = Layer.mergeAll(
      Layer.succeed(Logger, logger),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(OpencodeService, opencode),
    );
    const questions = yield* makeQuestionRuntime(sendQuestionUiFailure).pipe(
      Effect.provide(serviceLayer),
    );
    let runBatch!: Effect.Success<ReturnType<typeof makeRunOrchestrator>>;

    const worker = (session: ChannelSession): Effect.Effect<never, never, FsEnv> =>
      Effect.forever(
        takeQueuedRunBatch(session.queue).pipe(
          Effect.flatMap((requests) =>
            Ref.get(shutdownStartedRef).pipe(
              Effect.flatMap((shutdownStarted) =>
                shutdownStarted ? Effect.void : runBatch(session, requests),
              ),
            ),
          ),
          Effect.catch((error) =>
            logger.error("channel worker iteration failed", {
              channelId: session.channelId,
              error: formatError(error),
            }),
          ),
        ),
      );

    const sessionFields = (session: ChannelSession) => ({
      channelId: session.channelId,
      sessionId: session.opencode.sessionId,
    });
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
        yield* Effect.sync(() => {
          requestRunInterrupt(activeRun, "shutdown");
        });

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
      loadedSessions
        .findLoadedHandleBySessionId(sessionId)
        .pipe(
          Effect.flatMap((handle) =>
            !handle
              ? Effect.void
              : handle
                  .readActiveRun()
                  .pipe(
                    Effect.flatMap((activeRun) =>
                      activeRun
                        ? Effect.sleep(SHUTDOWN_DRAIN_POLL_INTERVAL).pipe(
                            Effect.andThen(awaitSessionIdleObservedAfterInterruptLoop(sessionId)),
                          )
                        : Effect.void,
                    ),
                  ),
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
      session.compactionWorkflow.requestInterrupt().pipe(
        withShutdownRpcTimeout("Timed out interrupting idle compaction during shutdown"),
        Effect.flatMap((result) =>
          result.type === "failed" ? Effect.fail(result.message) : Effect.void,
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
                session.compactionWorkflow
                  .handleInterrupted()
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

    const shutdown: SessionRuntimeShape["shutdown"] = () => {
      const startShutdown = () =>
        Ref.modify(shutdownStartedRef, (started): readonly [boolean, boolean] => [!started, true]);
      const requestSessionShutdown = (handle: LoadedSessionHandle) => handle.requestShutdown();
      const readShutdownDrainState = () =>
        loadedSessions.snapshotHandles().pipe(
          Effect.flatMap((handles) =>
            !handles.length
              ? Effect.succeed(null)
              : Effect.forEach(handles, (handle) => handle.readShutdownDrainState(), {
                  concurrency: "unbounded",
                  discard: false,
                }).pipe(
                  Effect.map((states) => {
                    const hasActiveRuns = states.some((state) => state.hasActiveRun);
                    const hasIdleCompactions = states.some((state) => state.hasIdleCompaction);
                    return hasActiveRuns || hasIdleCompactions
                      ? { hasActiveRuns, hasIdleCompactions }
                      : null;
                  }),
                ),
          ),
        );
      const awaitShutdownDrainLoop = (): Effect.Effect<void, unknown> =>
        readShutdownDrainState().pipe(
          Effect.flatMap((drainState) =>
            !drainState
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
              }),
            ),
          ),
        );
      const finalizeShutdownCleanup = () =>
        loadedSessions.snapshotHandles().pipe(
          Effect.flatMap((handles) =>
            Effect.forEach(
              handles,
              (handle) =>
                handle.finalizeShutdown().pipe(
                  catchShutdownWarn("failed to finalize session-local shutdown cleanup", () => ({
                    channelId: handle.channelId,
                  })),
                ),
              { concurrency: "unbounded", discard: true },
            ),
          ),
        );

      return startShutdown().pipe(
        Effect.flatMap((shouldRun) =>
          !shouldRun
            ? Effect.void
            : Effect.gen(function* () {
                const handles = yield* loadedSessions.snapshotHandles();
                yield* Effect.forEach(handles, requestSessionShutdown, {
                  concurrency: "unbounded",
                  discard: true,
                });
                yield* awaitShutdownDrain();
                yield* finalizeShutdownCleanup();
                yield* FiberSet.clear(fiberSet).pipe(
                  catchShutdownWarn("failed to interrupt session workers on shutdown"),
                );
                yield* sessionRegistry
                  .shutdownSessions()
                  .pipe(catchShutdownWarn("failed to shut down sessions"));
              }),
        ),
        Effect.catch((error) =>
          logger.warn("session orchestrator shutdown failed", {
            error: formatError(error),
          }),
        ),
      );
    };

    const readSessionActivity = (session: ChannelSession) =>
      Effect.all({
        hasPendingQuestions:
          session.activeRun?.questionWorkflow?.hasPendingQuestions() ?? Effect.succeed(false),
        hasIdleCompaction: session.compactionWorkflow.hasActive(),
        hasQueuedWork: Queue.size(session.queue).pipe(Effect.map((size) => size > 0)),
      }).pipe(
        Effect.map(({ hasPendingQuestions, hasIdleCompaction, hasQueuedWork }) => {
          const hasActiveRun = Boolean(session.activeRun);
          return {
            hasActiveRun,
            hasPendingQuestions,
            hasIdleCompaction,
            hasQueuedWork,
            isBusy: hasActiveRun || hasPendingQuestions || hasIdleCompaction || hasQueuedWork,
          } satisfies SessionActivity;
        }),
      );

    const sessionRegistry = yield* makeSessionRegistry(
      loadedSessions,
      {
        startWorker: (session) =>
          FiberSet.run(fiberSet, { startImmediately: true })(worker(session)).pipe(Effect.asVoid),
        readActivity: readSessionActivity,
        createCompactionWorkflow: (readSession) =>
          makeSessionCompactionWorkflow(readSession).pipe(Effect.provide(serviceLayer)),
        routeEvent: (session, event) =>
          routeLoadedSessionEvent(event, session, session.activeRun).pipe(
            Effect.provide(serviceLayer),
          ),
        interruptRunForShutdown,
        interruptCompactionForShutdown: interruptIdleCompactionForShutdown,
        awaitSessionIdleObservedAfterInterrupt,
        finalizeInterruptedRunShutdown: (session, activeRun) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore);
            yield* activeRun.finalizeProgress("interrupted");
            yield* infoCards
              .send(
                activeRun.originMessage.channel as SendableChannels,
                "🛑 Run interrupted",
                "OpenCode stopped the active run in this channel because the bot is shutting down.",
              )
              .pipe(Effect.ignore);
          }).pipe(
            catchShutdownWarn(
              "failed to finalize interrupted run progress during shutdown",
              () => ({
                channelId: session.channelId,
                sessionId: session.opencode.sessionId,
              }),
            ),
          ),
      },
      config.sessionInstructions,
      config.triggerPhrase,
      config.sessionIdleTimeoutMs,
    ).pipe(Effect.provide(SessionStoreLayer));
    const runtimeServiceLayer = Layer.mergeAll(
      serviceLayer,
      Layer.succeed(QuestionRuntime, questions),
      Layer.succeed(RunSessionLifecycle, {
        setActiveRun: sessionRegistry.updateActiveRun,
        recoverSession: (session: ChannelSession, responseMessage: Message) =>
          sessionRegistry
            .ensureHealthySession(
              session,
              responseMessage,
              "run failed with unhealthy opencode session",
              false,
            )
            .pipe(Effect.asVoid),
      }),
    );

    yield* Queue.take(eventQueue).pipe(
      Effect.flatMap((event) => {
        const sessionId = getEventSessionId(event.payload);
        if (!sessionId) {
          return Effect.void;
        }
        return sessionRegistry
          .findLoadedHandleBySessionId(sessionId)
          .pipe(
            Effect.flatMap((handle) => (!handle ? Effect.void : handle.routeEvent(event.payload))),
          );
      }),
      Effect.forever,
      Effect.catch((error) =>
        logger.error("opencode event dispatcher failed", {
          error: formatError(error),
        }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.sleep(60_000).pipe(
      Effect.andThen(sessionRegistry.closeExpiredSessions()),
      Effect.forever,
      Effect.catch((error) =>
        logger.error("idle session sweeper failed", {
          error: formatError(error),
        }),
      ),
      Effect.forkScoped,
    );

    runBatch = yield* makeRunOrchestrator().pipe(Effect.provide(runtimeServiceLayer));

    const readChannelActivity = <R>(
      handleEffect: Effect.Effect<LoadedSessionHandle | null | undefined, unknown, R>,
    ) =>
      handleEffect.pipe(
        Effect.flatMap((handle) =>
          !handle
            ? Effect.succeed<ChannelActivity>({ type: "missing" })
            : handle.readActivity().pipe(
                Effect.map(
                  (activity): ChannelActivity => ({
                    type: "present",
                    activity,
                  }),
                ),
              ),
        ),
      );

    const interruptFailure = (error: string | unknown): RunInterruptRequestResult => ({
      type: "failed",
      error: typeof error === "string" ? new Error(error) : error,
    });

    const requestSessionRunInterrupt = (handle: LoadedSessionHandle) =>
      Effect.gen(function* () {
        const session = yield* handle.readSession();
        const activeRun = yield* handle.readActiveRun();
        if (!activeRun) {
          return interruptFailure("no active run for session");
        }

        yield* Effect.sync(() => {
          requestRunInterrupt(activeRun, "user");
        });
        return yield* opencode.interruptSession(session.opencode).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                clearRunInterrupt(activeRun);
              }).pipe(Effect.as(interruptFailure(error))),
            onSuccess: () =>
              handle.readActivity().pipe(
                Effect.flatMap((updatedActivity) =>
                  !updatedActivity.hasPendingQuestions
                    ? Effect.succeed<RunInterruptRequestResult>({
                        type: "requested",
                      })
                    : Effect.sync(() => {
                        clearRunInterrupt(activeRun);
                      }).pipe(
                        Effect.as<RunInterruptRequestResult>({
                          type: "question-pending",
                        }),
                      ),
                ),
              ),
          }),
        );
      });

    const withRestoredHandle = <A>(
      channelId: string,
      onPresent: (handle: LoadedSessionHandle) => Effect.Effect<A, unknown, FsEnv>,
      onMissing: () => Effect.Effect<A, unknown>,
    ) =>
      sessionRegistry
        .findOrRestoreHandle(channelId)
        .pipe(Effect.flatMap((handle) => (handle ? onPresent(handle) : onMissing())));

    return Layer.succeed(SessionRuntime, {
      activity: {
        readChannel: (channelId, mode) =>
          readChannelActivity(
            mode === "loaded"
              ? sessionRegistry.findLoadedHandle(channelId)
              : sessionRegistry.findOrRestoreHandle(channelId),
          ),
      },
      runs: {
        getActiveBySessionId: sessionRegistry.findActiveRunBySessionId,
        queueMessage: (message, request, reason) =>
          Effect.gen(function* () {
            const handle = yield* sessionRegistry
              .ensureHandleForMessage(message)
              .pipe(
                Effect.flatMap((handle) =>
                  sessionRegistry.ensureHealthyHandle(handle, message, reason),
                ),
              );
            yield* handle.updateProgressContext(
              message.channel.isSendable() ? (message.channel as SendableChannels) : null,
              message,
            );
            const destination = yield* handle.queueRunRequest(request);
            return {
              sessionId: yield* handle.readSessionId(),
              destination,
            } satisfies QueuedMessageRunRequest;
          }),
        requestInterrupt: (channelId) =>
          withRestoredHandle(channelId, requestSessionRunInterrupt, () =>
            Effect.succeed(interruptFailure("no session for channel")),
          ),
      },
      questions: {
        routeInteraction: (interaction) =>
          Effect.gen(function* () {
            if (
              !interaction.isButton() &&
              !interaction.isStringSelectMenu() &&
              !interaction.isModalSubmit()
            ) {
              return;
            }

            const action = parseQuestionActionId(interaction.customId);
            if (!action) {
              return;
            }

            const handle = yield* sessionRegistry.findLoadedHandleBySessionId(action.sessionID);
            if (!handle) {
              if (!interaction.replied && !interaction.deferred) {
                yield* Effect.promise(() =>
                  interaction.reply(questionInteractionReply("This question prompt has expired.")),
                ).pipe(Effect.ignore);
              }
              return;
            }

            yield* handle.routeQuestionInteraction(interaction);
          }),
      },
      channels: {
        invalidate: sessionRegistry.invalidateSession,
        updateLoadedSettings: (channelId, settings) =>
          sessionRegistry
            .findLoadedHandle(channelId)
            .pipe(
              Effect.flatMap((handle) =>
                !handle ? Effect.void : handle.updateChannelSettings(settings),
              ),
            ),
      },
      compaction: {
        start: (channelId, channel) =>
          withRestoredHandle(
            channelId,
            (handle) =>
              handle
                .updateProgressContext(channel, null)
                .pipe(Effect.andThen(handle.startCompaction(channel))),
            () =>
              Effect.succeed({
                type: "rejected",
                message: "No OpenCode session exists in this channel yet.",
              } satisfies SessionCompactionStartResult),
          ),
        requestInterrupt: (channelId) =>
          withRestoredHandle(
            channelId,
            (handle) => handle.requestCompactionInterrupt(),
            () =>
              Effect.succeed({
                type: "failed",
                message: "No active OpenCode run or compaction is running in this channel.",
              } satisfies SessionCompactionInterruptResult),
          ),
      },
      shutdown,
    } satisfies SessionRuntimeShape);
  }),
);
