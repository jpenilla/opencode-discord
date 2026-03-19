import { describe, expect, test } from "bun:test";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Message,
  type SendableChannels,
} from "discord.js";
import { Deferred, Effect, Layer, Queue, Ref } from "effect";

import {
  NEW_SESSION_BUSY_MESSAGE,
  QUESTION_PENDING_INTERRUPT_MESSAGE,
  QUESTION_PENDING_NEW_SESSION_MESSAGE,
} from "@/channels/command-policy.ts";
import { createCommandHandler } from "@/channels/command-handler.ts";
import { AppConfig, type AppConfigShape } from "@/config.ts";
import { InfoCards, type InfoCardsShape } from "@/discord/info-cards.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { createPromptState } from "@/sessions/run/prompt-state.ts";
import {
  type IdleCompactionWorkflowShape,
  type IdleCompactionWorkflowInterruptResult,
  type IdleCompactionWorkflowStartResult,
} from "@/sessions/compaction/idle-compaction-workflow.ts";
import {
  type ChannelActivity,
  SessionChannelBridge,
  type SessionChannelBridgeShape,
} from "@/sessions/session-runtime.ts";
import {
  noQuestionOutcome,
  type ActiveRun,
  type ChannelSession,
  type RunRequest,
} from "@/sessions/session.ts";
import type { PersistedChannelSettings } from "@/state/channel-settings.ts";
import {
  ChannelSettingsPersistence,
  type ChannelSettingsPersistenceShape,
} from "@/state/persistence.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";
import { unsafeStub } from "../support/stub.ts";

const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref));

const makeConfig = (defaults: {
  showThinking: boolean;
  showCompactionSummaries: boolean;
}): AppConfigShape => ({
  discordToken: { raw: "<redacted>" } as never,
  triggerPhrase: "hey opencode",
  ignoreOtherBotTriggers: false,
  sessionInstructions: "",
  stateDir: "/tmp/opencode-discord-test-state",
  defaultProviderId: undefined,
  defaultModelId: undefined,
  showThinkingByDefault: defaults.showThinking,
  showCompactionSummariesByDefault: defaults.showCompactionSummaries,
  sessionIdleTimeoutMs: 30 * 60 * 1_000,
  toolBridgeSocketPath: "/tmp/bridge.sock",
  toolBridgeToken: { raw: "<redacted>" } as never,
  sandboxBackend: "bwrap",
  opencodeBin: "opencode",
  bwrapBin: "bwrap",
  sandboxReadOnlyPaths: [],
  sandboxEnvPassthrough: [],
});

type HarnessOptions = {
  sessionHealthy?: boolean;
  interruptResult?: "success" | "failure";
  hasActiveRun?: boolean;
  hasPendingQuestions?: boolean;
  hasPendingQuestionsSequence?: boolean[];
  hasOtherBusyState?: boolean;
  hasSession?: boolean;
  hasQueuedWork?: boolean;
  hasIdleCompaction?: boolean;
  initialChannelSettings?: PersistedChannelSettings | null;
  failInfoCardUpsert?: boolean;
  invalidateResult?: "success" | "busy" | "failure";
};

const makeCommandsLayer = (deps: {
  sessionBridge: SessionChannelBridgeShape;
  channelSettingsPersistence: ChannelSettingsPersistenceShape;
  infoCards: InfoCardsShape;
  logger: LoggerShape;
  config: AppConfigShape;
}) =>
  Layer.mergeAll(
    Layer.succeed(AppConfig, deps.config),
    Layer.succeed(ChannelSettingsPersistence, deps.channelSettingsPersistence),
    Layer.succeed(SessionChannelBridge, deps.sessionBridge),
    Layer.succeed(InfoCards, deps.infoCards),
    Layer.succeed(Logger, deps.logger),
  );

const makeHarness = async (options?: HarnessOptions) => {
  const replies = await Effect.runPromise(Ref.make<string[]>([]));
  const defers = await Effect.runPromise(Ref.make(0));
  const edits = await Effect.runPromise(Ref.make<string[]>([]));
  const compactionUpdates = await Effect.runPromise(
    Ref.make<Array<{ title: string; body: string }>>([]),
  );
  const upsertedInfoCards = await Effect.runPromise(
    Ref.make<Array<{ title: string; body: string }>>([]),
  );
  const typingStopCount = await Effect.runPromise(Ref.make(0));
  const idleCardRef = await Effect.runPromise(Ref.make<Message | null>(null));
  const idleCompactionActive = await Effect.runPromise(
    Ref.make(options?.hasIdleCompaction ?? false),
  );
  const idleInterruptRequested = await Effect.runPromise(Ref.make(false));
  const persistedSettings = await Effect.runPromise(
    Ref.make<Map<string, PersistedChannelSettings>>(new Map()),
  );
  const invalidatedSessions = await Effect.runPromise(
    Ref.make<Array<{ channelId: string; reason: string }>>([]),
  );
  const warnings = await Effect.runPromise(Ref.make<string[]>([]));
  const compactStarted = await Effect.runPromise(Deferred.make<void, never>());
  const compactFinish = await Effect.runPromise(Deferred.make<void, never>());
  const compactUpdated = await Effect.runPromise(Deferred.make<void, never>());
  const pendingQuestionCheckCount = await Effect.runPromise(Ref.make(0));
  const promptState = await Effect.runPromise(createPromptState());
  const channelSettingsDefaults = {
    showThinking: true,
    showCompactionSummaries: true,
  } as const;

  if (options?.initialChannelSettings) {
    await Effect.runPromise(
      Ref.set(
        persistedSettings,
        new Map([[options.initialChannelSettings.channelId, options.initialChannelSettings]]),
      ),
    );
  }

  const sessionQueue = await Effect.runPromise(Queue.unbounded<RunRequest>());
  if (options?.hasQueuedWork) {
    await Effect.runPromise(Queue.offer(sessionQueue, {} as RunRequest));
  }

  const activeRun: ActiveRun = {
    originMessage: unsafeStub<Message>({
      id: "discord-message",
      channelId: "channel-1",
      channel: { id: "channel-1" },
      attachments: new Map(),
    }),
    workdir: "/home/opencode/workspace",
    attachmentMessagesById: new Map(),
    currentPromptContext: null,
    previousPromptMessageIds: new Set<string>(),
    currentPromptMessageIds: new Set<string>(),
    currentPromptUserMessageId: null,
    assistantMessageParentIds: new Map<string, string>(),
    observedToolCallIds: new Set<string>(),
    progressQueue: {} as ActiveRun["progressQueue"],
    promptState,
    followUpQueue: {} as ActiveRun["followUpQueue"],
    acceptFollowUps: {} as ActiveRun["acceptFollowUps"],
    typing: {
      pause: async () => {},
      resume: () => {},
      stop: () => Effect.runPromise(Ref.update(typingStopCount, (count) => count + 1)),
    },
    finalizeProgress: () => Effect.void,
    questionOutcome: noQuestionOutcome(),
    interruptRequested: false,
    interruptSource: null,
  };

  const session: ChannelSession = {
    channelId: "channel-1",
    opencode: {
      sessionId: "session-1",
      client: {} as never,
      workdir: "/home/opencode/workspace",
      backend: "bwrap",
      close: () => Effect.void,
    },
    rootDir: "/tmp/session-root",
    workdir: "/home/opencode/workspace",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    channelSettings: {
      showThinking:
        options?.initialChannelSettings?.showThinking ?? channelSettingsDefaults.showThinking,
      showCompactionSummaries:
        options?.initialChannelSettings?.showCompactionSummaries ??
        channelSettingsDefaults.showCompactionSummaries,
    },
    progressChannel: null,
    progressMentionContext: null,
    emittedCompactionSummaryMessageIds: new Set<string>(),
    queue: sessionQueue,
    activeRun: (options?.hasActiveRun ?? false) ? activeRun : null,
  };

  const sessionRef = await Effect.runPromise(
    Ref.make((options?.hasSession ?? true) ? session : null),
  );

  const infoCards: InfoCardsShape = {
    send: () => Effect.succeed(unsafeStub<Message>({ id: "info-cards-send" })),
    edit: () => Effect.void,
    upsert: ({
      channel,
      title,
      body,
    }: {
      channel: SendableChannels;
      existingCard: Message | null;
      title: string;
      body: string;
    }) =>
      Effect.gen(function* () {
        if (options?.failInfoCardUpsert) {
          return yield* Effect.fail(new Error("card post failed"));
        }
        const card = unsafeStub<Message>({
          id: `${title}-${channel.id}`,
        });
        yield* Ref.update(upsertedInfoCards, (current) => [...current, { title, body }]);
        if (title === "🗜️ Compacting session") {
          yield* Ref.set(idleCardRef, card);
        }
        return card;
      }),
  };

  const logger: LoggerShape = {
    info: () => Effect.void,
    warn: (message) => Ref.update(warnings, (current) => [...current, message]),
    error: () => Effect.void,
  };

  const channelSettingsPersistence: ChannelSettingsPersistenceShape = {
    getChannelSettings: (channelId: string) =>
      Ref.get(persistedSettings).pipe(Effect.map((current) => current.get(channelId) ?? null)),
    upsertChannelSettings: (settings: PersistedChannelSettings) =>
      Ref.update(persistedSettings, (current) => {
        const next = new Map(current);
        next.set(settings.channelId, settings);
        return next;
      }),
  };

  const idleCompactionWorkflow: IdleCompactionWorkflowShape = {
    hasActive: () => Ref.get(idleCompactionActive),
    awaitCompletion: () => Effect.void,
    start: ({ channel }: { session: ChannelSession; channel: SendableChannels }) =>
      Effect.gen(function* () {
        if (options?.sessionHealthy === false) {
          return {
            type: "rejected",
            message:
              "This channel session is unavailable right now. Send a normal message to recreate it.",
          } satisfies IdleCompactionWorkflowStartResult;
        }

        yield* infoCards
          .upsert({
            channel,
            existingCard: null,
            title: "🗜️ Compacting session",
            body: "OpenCode is summarizing earlier context for this session.",
          })
          .pipe(Effect.ignore);
        yield* Ref.set(idleCompactionActive, true);
        yield* Deferred.succeed(compactStarted, undefined);

        yield* Effect.sync(() => {
          void Effect.runPromise(
            Deferred.await(compactFinish).pipe(
              Effect.flatMap(() =>
                Ref.update(compactionUpdates, (current) => [
                  ...current,
                  {
                    title: "🗜️ Session compacted",
                    body: "OpenCode summarized earlier context for this session.",
                  },
                ]),
              ),
              Effect.andThen(Ref.set(idleCardRef, null)),
              Effect.andThen(Ref.set(idleCompactionActive, false)),
              Effect.andThen(Deferred.succeed(compactUpdated, undefined)),
            ),
          );
        });

        return { type: "started" } satisfies IdleCompactionWorkflowStartResult;
      }),
    requestInterrupt: () =>
      Effect.gen(function* () {
        yield* Ref.set(idleInterruptRequested, true);
        yield* Ref.update(compactionUpdates, (current) => [
          ...current,
          {
            title: "‼️ Interrupting compaction",
            body: "OpenCode is stopping session compaction.",
          },
        ]);

        if (options?.interruptResult === "failure") {
          yield* Ref.update(compactionUpdates, (current) => [
            ...current,
            {
              title: "🗜️ Compacting session",
              body: "OpenCode is summarizing earlier context for this session.",
            },
          ]);
          yield* Ref.set(idleInterruptRequested, false);
          return {
            type: "failed",
            message: formatErrorResponse(
              "## ❌ Failed to interrupt compaction",
              "interrupt failed",
            ),
          } satisfies IdleCompactionWorkflowInterruptResult;
        }

        return { type: "interrupted" } satisfies IdleCompactionWorkflowInterruptResult;
      }),
    handleCompacted: () => Effect.void,
    handleInterrupted: () => Effect.void,
    emitSummary: () => Effect.void,
    shutdown: () => Effect.void,
  };

  const readSession = (channelId: string) =>
    Ref.get(sessionRef).pipe(
      Effect.map((current) => (current && current.channelId === channelId ? current : null)),
    );

  const readChannelActivity = (
    currentSession: ChannelSession | null,
  ): Effect.Effect<ChannelActivity> => {
    if (!currentSession) {
      return Effect.succeed({ type: "missing" });
    }
    return Effect.all({
      idleCompactionBusy: Ref.get(idleCompactionActive),
      queueSize: Queue.size(currentSession.queue),
      pendingQuestionCheckCount: Ref.updateAndGet(pendingQuestionCheckCount, (count) => count + 1),
    }).pipe(
      Effect.map(({ idleCompactionBusy, queueSize, pendingQuestionCheckCount }) => {
        const sequence = options?.hasPendingQuestionsSequence;
        const hasPendingQuestions =
          sequence && sequence.length > 0
            ? (sequence[Math.min(pendingQuestionCheckCount - 1, sequence.length - 1)] ?? false)
            : (options?.hasPendingQuestions ?? false);
        const hasQueuedWork = queueSize > 0;
        return {
          type: "present",
          activity: {
            hasActiveRun: Boolean(currentSession.activeRun),
            hasPendingQuestions,
            hasIdleCompaction: idleCompactionBusy,
            hasQueuedWork,
            isBusy:
              Boolean(currentSession.activeRun) ||
              idleCompactionBusy ||
              hasPendingQuestions ||
              hasQueuedWork ||
              (options?.hasOtherBusyState ?? false),
          },
        } satisfies ChannelActivity;
      }),
    );
  };

  const sessionBridge: SessionChannelBridgeShape = {
    readLoadedChannelActivity: (channelId: string) =>
      readSession(channelId).pipe(Effect.flatMap(readChannelActivity)),
    readRestoredChannelActivity: (channelId: string) =>
      readSession(channelId).pipe(Effect.flatMap(readChannelActivity)),
    queueMessageRunRequest: () => Effect.fail(new Error("unused in command tests")),
    routeQuestionInteraction: () => Effect.void,
    invalidate: (channelId: string, reason: string) =>
      Effect.gen(function* () {
        if (options?.invalidateResult === "failure") {
          return yield* Effect.fail(new Error("invalidate failed"));
        }
        if (options?.invalidateResult === "busy") {
          return false;
        }
        yield* Ref.update(invalidatedSessions, (current) => [
          ...current,
          { channelId: session.channelId, reason },
        ]);
        yield* Ref.update(sessionRef, (current) =>
          current && current.channelId === channelId ? null : current,
        );
        return true;
      }),
    updateLoadedChannelSettings: (channelId: string, settings) =>
      Ref.update(sessionRef, (current) => {
        if (current && current.channelId === channelId) {
          current.channelSettings = settings;
        }
        return current;
      }),
    requestRunInterrupt: (channelId: string) =>
      readSession(channelId).pipe(
        Effect.flatMap((currentSession) => {
          if (!currentSession || !currentSession.activeRun) {
            return Effect.succeed({
              type: "failed",
              error: new Error("no active run for session"),
            } as const);
          }

          return Effect.sync(() => {
            const activeRun: ActiveRun = currentSession.activeRun!;
            activeRun.interruptRequested = true;
            activeRun.interruptSource = "user";

            if (options?.interruptResult === "failure") {
              activeRun.interruptRequested = false;
              activeRun.interruptSource = null;
              return {
                type: "failed",
                error: new Error("interrupt failed"),
              } as const;
            }

            const hasPendingQuestions =
              options?.hasPendingQuestionsSequence?.[1] ??
              options?.hasPendingQuestionsSequence?.[0] ??
              options?.hasPendingQuestions ??
              false;
            if (hasPendingQuestions) {
              activeRun.interruptRequested = false;
              activeRun.interruptSource = null;
              return {
                type: "question-pending",
              } as const;
            }

            return {
              type: "requested",
            } as const;
          });
        }),
      ),
    startCompaction: (channelId: string, channel) =>
      readSession(channelId).pipe(
        Effect.flatMap((currentSession) =>
          !currentSession
            ? Effect.succeed({
                type: "rejected",
                message: "No OpenCode session exists in this channel yet.",
              } satisfies IdleCompactionWorkflowStartResult)
            : idleCompactionWorkflow.start({ session: currentSession, channel }),
        ),
      ),
    requestCompactionInterrupt: (channelId: string) =>
      readSession(channelId).pipe(
        Effect.flatMap((currentSession) =>
          !currentSession
            ? Effect.succeed({
                type: "failed",
                message: "No active OpenCode run or compaction is running in this channel.",
              } satisfies IdleCompactionWorkflowInterruptResult)
            : idleCompactionWorkflow.requestInterrupt({ session: currentSession }),
        ),
      ),
    shutdown: () => Effect.void,
  };

  const commandsLayer = makeCommandsLayer({
    sessionBridge,
    channelSettingsPersistence,
    infoCards,
    logger,
    config: makeConfig(channelSettingsDefaults),
  });

  const runtime = createCommandHandler({
    commandLayer: commandsLayer,
  });

  const interaction = unsafeStub<
    ChatInputCommandInteraction & {
      replied: boolean;
      deferred: boolean;
      commandName: string;
    }
  >({
    channelId: "channel-1",
    commandName: "compact",
    channel: unsafeStub<SendableChannels>({
      id: "channel-1",
      type: ChannelType.GuildText,
    }),
    replied: false,
    deferred: false,
    inGuild: () => true,
    isChatInputCommand: () => true,
    reply: ({ content }: { content?: string }) => {
      interaction.replied = true;
      return Effect.runPromise(Ref.update(replies, (current) => [...current, content ?? ""]));
    },
    deferReply: () => {
      interaction.deferred = true;
      return Effect.runPromise(Ref.update(defers, (count) => count + 1));
    },
    editReply: ({ content }: { content?: string }) =>
      Effect.runPromise(Ref.update(edits, (current) => [...current, content ?? ""])),
  });

  return {
    runtime,
    session,
    interaction,
    activeRun,
    replies,
    defers,
    edits,
    compactionUpdates,
    upsertedInfoCards,
    typingStopCount,
    idleCardRef,
    idleCompactionActive,
    invalidatedSessions,
    warnings,
    persistedSettings,
    compactStarted,
    compactFinish,
    compactUpdated,
    idleInterruptRequested,
  };
};

describe("createCommandHandler", () => {
  test("rejects unhealthy compact requests after deferring", async () => {
    const harness = await makeHarness({
      sessionHealthy: false,
    });

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([
      "This channel session is unavailable right now. Send a normal message to recreate it.",
    ]);
    expect(await getRef(harness.upsertedInfoCards)).toEqual([]);
  });

  test("starts compaction, posts the idle card, and clears it after completion", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));

    await Effect.runPromise(Deferred.await(harness.compactStarted));
    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.upsertedInfoCards)).toEqual([
      {
        title: "🗜️ Compacting session",
        body: "OpenCode is summarizing earlier context for this session.",
      },
    ]);
    expect((await getRef(harness.idleCardRef))?.id).toBe("🗜️ Compacting session-channel-1");
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([
      "Started session compaction. I'll post updates in this channel.",
    ]);

    await Effect.runPromise(Deferred.succeed(harness.compactFinish, undefined));
    await Effect.runPromise(Deferred.await(harness.compactUpdated));

    expect(await getRef(harness.compactionUpdates)).toContainEqual({
      title: "🗜️ Session compacted",
      body: "OpenCode summarized earlier context for this session.",
    });
    expect(await getRef(harness.idleCardRef)).toBeNull();
  });

  test("rolls back interruptRequested when interrupting fails", async () => {
    const harness = await makeHarness({
      interruptResult: "failure",
      hasActiveRun: true,
    });
    harness.interaction.commandName = "interrupt";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(harness.activeRun.interruptRequested).toBe(false);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([
      formatErrorResponse("## ❌ Failed to interrupt run", "interrupt failed"),
    ]);
  });

  test("requests interruption of the active run without claiming success yet", async () => {
    const harness = await makeHarness({
      hasActiveRun: true,
    });
    harness.interaction.commandName = "interrupt";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(harness.activeRun.interruptRequested).toBe(true);
    expect(await getRef(harness.typingStopCount)).toBe(0);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([
      "Requested interruption of the active OpenCode run.",
    ]);
  });

  test("rejects interrupt while a question prompt is pending", async () => {
    const harness = await makeHarness({
      hasActiveRun: true,
      hasPendingQuestions: true,
    });
    harness.interaction.commandName = "interrupt";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(harness.activeRun.interruptRequested).toBe(false);
    expect(await getRef(harness.defers)).toBe(0);
    expect(await getRef(harness.replies)).toEqual([QUESTION_PENDING_INTERRUPT_MESSAGE]);
    expect(await getRef(harness.edits)).toEqual([]);
    expect(await getRef(harness.typingStopCount)).toBe(0);
  });

  test("rejects interrupt while a question prompt is pending without an active run", async () => {
    const harness = await makeHarness({
      hasPendingQuestions: true,
    });
    harness.interaction.commandName = "interrupt";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.defers)).toBe(0);
    expect(await getRef(harness.replies)).toEqual([QUESTION_PENDING_INTERRUPT_MESSAGE]);
    expect(await getRef(harness.edits)).toEqual([]);
    expect(await getRef(harness.typingStopCount)).toBe(0);
  });

  test("reports a lost interrupt when questions become pending right after the interrupt request succeeds", async () => {
    const harness = await makeHarness({
      hasActiveRun: true,
      hasPendingQuestionsSequence: [false, true],
    });
    harness.interaction.commandName = "interrupt";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(harness.activeRun.interruptRequested).toBe(false);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([QUESTION_PENDING_INTERRUPT_MESSAGE]);
  });

  test("interrupts an active compaction card without posting a run card", async () => {
    const harness = await makeHarness();
    harness.interaction.commandName = "interrupt";
    await Effect.runPromise(
      Ref.set(harness.idleCardRef, unsafeStub<Message>({ id: "compaction-card" })),
    );
    await Effect.runPromise(Ref.set(harness.idleCompactionActive, true));

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.typingStopCount)).toBe(0);
    expect(await getRef(harness.compactionUpdates)).toEqual([
      {
        title: "‼️ Interrupting compaction",
        body: "OpenCode is stopping session compaction.",
      },
    ]);
    expect((await getRef(harness.idleCardRef))?.id).toBe("compaction-card");
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([
      "Requested interruption of the active OpenCode compaction.",
    ]);
  });

  test("restores the compaction card when interrupting compaction fails", async () => {
    const harness = await makeHarness({
      interruptResult: "failure",
    });
    harness.interaction.commandName = "interrupt";
    await Effect.runPromise(
      Ref.set(harness.idleCardRef, unsafeStub<Message>({ id: "compaction-card" })),
    );
    await Effect.runPromise(Ref.set(harness.idleCompactionActive, true));

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.idleInterruptRequested)).toBe(false);
    expect(await getRef(harness.compactionUpdates)).toEqual([
      {
        title: "‼️ Interrupting compaction",
        body: "OpenCode is stopping session compaction.",
      },
      {
        title: "🗜️ Compacting session",
        body: "OpenCode is summarizing earlier context for this session.",
      },
    ]);
    expect((await getRef(harness.idleCardRef))?.id).toBe("compaction-card");
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([
      formatErrorResponse("## ❌ Failed to interrupt compaction", "interrupt failed"),
    ]);
  });

  test("clears the channel session for the next triggered message", async () => {
    const harness = await makeHarness({
      hasSession: false,
    });
    harness.interaction.commandName = "new-session";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.invalidatedSessions)).toEqual([
      {
        channelId: "channel-1",
        reason: "requested a fresh session via /new-session",
      },
    ]);
    expect(await getRef(harness.upsertedInfoCards)).toEqual([
      {
        title: "🆕 Fresh session ready",
        body: "The next triggered message in this channel will start a new OpenCode session with fresh chat history. Workspace files were left in place.",
      },
    ]);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([
      "Cleared this channel's current OpenCode session. The next triggered message here will start a new session with fresh chat history. Workspace files were left in place.",
    ]);
  });

  test("logs and still replies when the fresh session info card cannot be posted", async () => {
    const harness = await makeHarness({
      hasSession: false,
      failInfoCardUpsert: true,
    });
    harness.interaction.commandName = "new-session";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.edits)).toEqual([
      "Cleared this channel's current OpenCode session. The next triggered message here will start a new session with fresh chat history. Workspace files were left in place.",
    ]);
    expect(await getRef(harness.warnings)).toEqual(["failed to post fresh session info card"]);
  });

  test("completes a deferred command with a generic error when unhandled work fails after ack", async () => {
    const harness = await makeHarness({
      hasSession: false,
      invalidateResult: "failure",
    });
    harness.interaction.commandName = "new-session";

    await expect(
      Effect.runPromise(harness.runtime.handleInteraction(harness.interaction)),
    ).rejects.toThrow("invalidate failed");

    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([
      "An unexpected error occurred while processing this command.",
    ]);
  });

  test("rejects /new-session while a run is active", async () => {
    const harness = await makeHarness({
      hasActiveRun: true,
    });
    harness.interaction.commandName = "new-session";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.defers)).toBe(0);
    expect(await getRef(harness.replies)).toEqual([
      "OpenCode is busy in this channel right now. Wait for the current run to finish or use /interrupt before starting a fresh session.",
    ]);
    expect(await getRef(harness.invalidatedSessions)).toEqual([]);
  });

  test("rejects /new-session while a question prompt is pending", async () => {
    const harness = await makeHarness({
      hasPendingQuestions: true,
    });
    harness.interaction.commandName = "new-session";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.defers)).toBe(0);
    expect(await getRef(harness.replies)).toEqual([QUESTION_PENDING_NEW_SESSION_MESSAGE]);
    expect(await getRef(harness.invalidatedSessions)).toEqual([]);
  });

  test("rejects /new-session while compaction is active", async () => {
    const harness = await makeHarness({
      hasIdleCompaction: true,
    });
    harness.interaction.commandName = "new-session";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.defers)).toBe(0);
    expect(await getRef(harness.replies)).toEqual([
      "OpenCode is compacting this channel right now. Wait for compaction to finish or use /interrupt before starting a fresh session.",
    ]);
    expect(await getRef(harness.invalidatedSessions)).toEqual([]);
  });

  test("rejects /new-session while queued work is still pending", async () => {
    const harness = await makeHarness({
      hasQueuedWork: true,
    });
    harness.interaction.commandName = "new-session";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.defers)).toBe(0);
    expect(await getRef(harness.replies)).toEqual([
      "OpenCode still has queued work for this channel. Wait for it to finish before starting a fresh session.",
    ]);
    expect(await getRef(harness.invalidatedSessions)).toEqual([]);
  });

  test("rejects /new-session on other busy states", async () => {
    const harness = await makeHarness({
      hasOtherBusyState: true,
    });
    harness.interaction.commandName = "new-session";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.defers)).toBe(0);
    expect(await getRef(harness.replies)).toEqual([NEW_SESSION_BUSY_MESSAGE]);
    expect(await getRef(harness.invalidatedSessions)).toEqual([]);
  });

  test("rechecks busy state when /new-session loses the invalidate race", async () => {
    const harness = await makeHarness({
      invalidateResult: "busy",
      hasPendingQuestionsSequence: [false, true],
    });
    harness.interaction.commandName = "new-session";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([QUESTION_PENDING_NEW_SESSION_MESSAGE]);
    expect(await getRef(harness.invalidatedSessions)).toEqual([]);
  });

  test("toggles thinking visibility for a channel without requiring a session", async () => {
    const harness = await makeHarness({
      hasSession: false,
    });
    harness.interaction.commandName = "toggle-thinking";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.replies)).toEqual([
      "Thinking messages are now disabled in this channel.",
    ]);
    expect(await getRef(harness.persistedSettings)).toEqual(
      new Map([
        [
          "channel-1",
          {
            channelId: "channel-1",
            showThinking: false,
            showCompactionSummaries: undefined,
          },
        ],
      ]),
    );
  });

  test("toggles compaction summary visibility and updates the loaded session", async () => {
    const harness = await makeHarness();
    harness.interaction.commandName = "toggle-compaction-summaries";

    await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(await getRef(harness.replies)).toEqual([
      "Compaction summaries are now disabled in this channel.",
    ]);
    expect(harness.session.channelSettings).toEqual({
      showThinking: true,
      showCompactionSummaries: false,
    });
  });
});
