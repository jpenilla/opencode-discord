import type { Event } from "@opencode-ai/sdk/v2";
import type { Interaction, Message, SendableChannels } from "discord.js";
import { Effect, FileSystem, Path, Queue } from "effect";

import { questionInteractionReply } from "@/discord/question-card.ts";
import type {
  SessionCompactionWorkflow,
  SessionCompactionInterruptResult,
  SessionCompactionStartResult,
} from "@/sessions/compaction/session-compaction-workflow.ts";
import type { SessionActivity } from "@/sessions/session-activity.ts";
import { enqueueRunRequest, type RunRequestDestination } from "@/sessions/request-routing.ts";
import type { ActiveRun, ChannelSession, RunRequest } from "@/sessions/session.ts";
import type { ChannelSettings } from "@/state/channel-settings.ts";

type FsEnv = FileSystem.FileSystem | Path.Path;

export type SessionContext = { session: ChannelSession; activeRun: ActiveRun | null };

export type LoadedSessionHandle = {
  channelId: string;
  readSession: () => Effect.Effect<ChannelSession>;
  readSessionId: () => Effect.Effect<string>;
  readContext: () => Effect.Effect<SessionContext>;
  readActiveRun: () => Effect.Effect<ActiveRun | null>;
  readActivity: () => Effect.Effect<SessionActivity, unknown>;
  setActiveRun: (activeRun: ActiveRun | null) => Effect.Effect<void>;
  touchActivity: (at?: number) => Effect.Effect<void>;
  updateChannelSettings: (settings: ChannelSettings) => Effect.Effect<void>;
  updateProgressContext: (
    progressChannel: SendableChannels | null,
    progressMentionContext: Message | null,
  ) => Effect.Effect<void>;
  queueRunRequest: (request: RunRequest) => Effect.Effect<RunRequestDestination>;
  hasActiveCompaction: () => Effect.Effect<boolean, unknown>;
  awaitCompactionCompletion: () => Effect.Effect<void, unknown>;
  startCompaction: (
    channel: SendableChannels,
  ) => Effect.Effect<SessionCompactionStartResult, unknown>;
  requestCompactionInterrupt: () => Effect.Effect<SessionCompactionInterruptResult, unknown>;
  handleCompacted: () => Effect.Effect<void, unknown>;
  handleCompactionInterrupted: () => Effect.Effect<void, unknown>;
  emitCompactionSummary: (messageId: string) => Effect.Effect<void, unknown>;
  routeQuestionInteraction: (interaction: Interaction) => Effect.Effect<void, unknown>;
  routeEvent: (event: Event) => Effect.Effect<void, unknown>;
  readShutdownDrainState: () => Effect.Effect<
    { hasActiveRun: boolean; hasIdleCompaction: boolean },
    unknown
  >;
  requestShutdown: () => Effect.Effect<void, unknown>;
  finalizeShutdown: () => Effect.Effect<void, unknown>;
  shutdownCompaction: () => Effect.Effect<void, unknown>;
  clearQueue: () => Effect.Effect<void>;
  startWorker: () => Effect.Effect<void, unknown, FsEnv>;
  closeResources: () => Effect.Effect<void>;
};

export type LoadedSessionHandleSupport = {
  startWorker: (session: ChannelSession) => Effect.Effect<void, unknown, FsEnv>;
  readActivity: (session: ChannelSession) => Effect.Effect<SessionActivity, unknown>;
  createCompactionWorkflow: (
    readSession: () => ChannelSession,
  ) => Effect.Effect<SessionCompactionWorkflow, unknown>;
  routeEvent: (session: ChannelSession, event: Event) => Effect.Effect<void, unknown>;
  interruptRunForShutdown: (
    session: ChannelSession,
    activeRun: ActiveRun,
  ) => Effect.Effect<boolean, unknown>;
  interruptCompactionForShutdown: (session: ChannelSession) => Effect.Effect<void, unknown>;
  awaitSessionIdleObservedAfterInterrupt: (session: ChannelSession) => Effect.Effect<void, unknown>;
  finalizeInterruptedRunShutdown: (
    session: ChannelSession,
    activeRun: ActiveRun,
  ) => Effect.Effect<void, unknown>;
};

export const makeLoadedSessionHandle = (
  session: ChannelSession,
  support: LoadedSessionHandleSupport,
): LoadedSessionHandle => ({
  channelId: session.channelId,
  readSession: () => Effect.succeed(session),
  readSessionId: () => Effect.succeed(session.opencode.sessionId),
  readContext: () =>
    Effect.succeed({
      session,
      activeRun: session.activeRun,
    } satisfies SessionContext),
  readActiveRun: () => Effect.succeed(session.activeRun),
  readActivity: () => support.readActivity(session),
  setActiveRun: (activeRun) =>
    Effect.sync(() => {
      session.activeRun = activeRun;
    }),
  touchActivity: (at = Date.now()) =>
    Effect.sync(() => {
      session.lastActivityAt = at;
    }),
  updateChannelSettings: (settings) =>
    Effect.sync(() => {
      session.channelSettings = settings;
    }),
  updateProgressContext: (progressChannel, progressMentionContext) =>
    Effect.sync(() => {
      session.progressChannel = progressChannel;
      session.progressMentionContext = progressMentionContext;
    }),
  queueRunRequest: (request) => enqueueRunRequest(session, request),
  hasActiveCompaction: () => session.compactionWorkflow.hasActive(),
  awaitCompactionCompletion: () => session.compactionWorkflow.awaitCompletion(),
  startCompaction: (channel) => session.compactionWorkflow.start(channel),
  requestCompactionInterrupt: () => session.compactionWorkflow.requestInterrupt(),
  handleCompacted: () => session.compactionWorkflow.handleCompacted(),
  handleCompactionInterrupted: () => session.compactionWorkflow.handleInterrupted(),
  emitCompactionSummary: (messageId) => session.compactionWorkflow.emitSummary(messageId),
  routeQuestionInteraction: (interaction) =>
    session.activeRun?.questionWorkflow
      ? session.activeRun.questionWorkflow.routeInteraction(interaction)
      : !interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()
        ? Effect.void
        : interaction.replied || interaction.deferred
          ? Effect.void
          : Effect.promise(() =>
              interaction.reply(questionInteractionReply("This question prompt has expired.")),
            ).pipe(Effect.ignore),
  routeEvent: (event) => support.routeEvent(session, event),
  readShutdownDrainState: () =>
    session.compactionWorkflow.hasActive().pipe(
      Effect.map((hasIdleCompaction) => ({
        hasActiveRun: Boolean(session.activeRun),
        hasIdleCompaction,
      })),
    ),
  requestShutdown: () =>
    Effect.gen(function* () {
      yield* session.compactionWorkflow.shutdown();
      yield* Queue.clear(session.queue).pipe(Effect.asVoid);

      const activeRun = session.activeRun;
      if (activeRun) {
        const interrupted = yield* support.interruptRunForShutdown(session, activeRun);
        if (interrupted) {
          yield* support.awaitSessionIdleObservedAfterInterrupt(session);
        }
        yield* activeRun.questionWorkflow?.shutdown() ?? Effect.void;
        return;
      }

      if (yield* session.compactionWorkflow.hasActive()) {
        yield* support.interruptCompactionForShutdown(session);
      }
    }),
  finalizeShutdown: () =>
    Effect.gen(function* () {
      const activeRun = session.activeRun;
      if (activeRun) {
        yield* support.finalizeInterruptedRunShutdown(session, activeRun);
      }
      if (yield* session.compactionWorkflow.hasActive()) {
        yield* session.compactionWorkflow.handleInterrupted();
      }
    }),
  shutdownCompaction: () => session.compactionWorkflow.shutdown(),
  clearQueue: () => Queue.clear(session.queue).pipe(Effect.asVoid),
  startWorker: () => support.startWorker(session),
  closeResources: () =>
    Queue.shutdown(session.queue).pipe(
      Effect.ignore,
      Effect.andThen(session.compactionWorkflow.shutdown().pipe(Effect.ignore)),
      Effect.andThen(session.opencode.close().pipe(Effect.ignore)),
    ),
});
