import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Message,
  type SendableChannels,
} from "discord.js";
import { Deferred, Effect, Layer, Queue, Ref } from "effect";

import {
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
import { getRef } from "../support/fixtures.ts";
import { failTest } from "../support/errors.ts";
import { unsafeStub } from "../support/stub.ts";

const runEffect = <A, E = never, R = never>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)) as Effect.Effect<A, E, never>);

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
  const replies = await runEffect(Ref.make<string[]>([]));
  const defers = await runEffect(Ref.make(0));
  const edits = await runEffect(Ref.make<string[]>([]));
  const compactionUpdates = await runEffect(Ref.make<Array<{ title: string; body: string }>>([]));
  const upsertedInfoCards = await runEffect(Ref.make<Array<{ title: string; body: string }>>([]));
  const typingStopCount = await runEffect(Ref.make(0));
  const idleCardRef = await runEffect(Ref.make<Message | null>(null));
  const idleCompactionActive = await runEffect(Ref.make(options?.hasIdleCompaction ?? false));
  const idleInterruptRequested = await runEffect(Ref.make(false));
  const persistedSettings = await runEffect(
    Ref.make<Map<string, PersistedChannelSettings>>(new Map()),
  );
  const invalidatedSessions = await runEffect(
    Ref.make<Array<{ channelId: string; reason: string }>>([]),
  );
  const warnings = await runEffect(Ref.make<string[]>([]));
  const compactStarted = await runEffect(Deferred.make<void, never>());
  const compactFinish = await runEffect(Deferred.make<void, never>());
  const compactUpdated = await runEffect(Deferred.make<void, never>());
  const pendingQuestionCheckCount = await runEffect(Ref.make(0));
  const promptState = await runEffect(createPromptState());
  const channelSettingsDefaults = {
    showThinking: true,
    showCompactionSummaries: true,
  } as const;

  if (options?.initialChannelSettings) {
    await runEffect(
      Ref.set(
        persistedSettings,
        new Map([[options.initialChannelSettings.channelId, options.initialChannelSettings]]),
      ),
    );
  }

  const sessionQueue = await runEffect(Queue.unbounded<RunRequest>());
  if (options?.hasQueuedWork) {
    await runEffect(Queue.offer(sessionQueue, {} as RunRequest));
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
      stop: () => runEffect(Ref.update(typingStopCount, (count) => count + 1)),
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

  const sessionRef = await runEffect(Ref.make((options?.hasSession ?? true) ? session : null));

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
          return yield* failTest("card post failed");
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
          void runEffect(
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
    queueMessageRunRequest: () => failTest("unused in command tests"),
    routeQuestionInteraction: () => Effect.void,
    invalidate: (channelId: string, reason: string) =>
      Effect.gen(function* () {
        if (options?.invalidateResult === "failure") {
          return yield* failTest("invalidate failed");
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
      return runEffect(Ref.update(replies, (current) => [...current, content ?? ""]));
    },
    deferReply: () => {
      interaction.deferred = true;
      return runEffect(Ref.update(defers, (count) => count + 1));
    },
    editReply: ({ content }: { content?: string }) =>
      runEffect(Ref.update(edits, (current) => [...current, content ?? ""])),
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

const runInteraction = async (
  harness: Awaited<ReturnType<typeof makeHarness>>,
  commandName: string,
) => {
  harness.interaction.commandName = commandName;
  await runEffect(harness.runtime.handleInteraction(harness.interaction));
  return harness;
};

describe("createCommandHandler", () => {
  test("rejects unhealthy compact requests after deferring", async () => {
    const harness = await runInteraction(await makeHarness({ sessionHealthy: false }), "compact");
    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([
      "This channel session is unavailable right now. Send a normal message to recreate it.",
    ]);
    expect(await getRef(harness.upsertedInfoCards)).toEqual([]);
  });

  test("starts compaction, posts the idle card, and clears it after completion", async () => {
    const harness = await runInteraction(await makeHarness(), "compact");
    await runEffect(Deferred.await(harness.compactStarted));
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

    await runEffect(Deferred.succeed(harness.compactFinish, undefined));
    await runEffect(Deferred.await(harness.compactUpdated));

    expect(await getRef(harness.compactionUpdates)).toContainEqual({
      title: "🗜️ Session compacted",
      body: "OpenCode summarized earlier context for this session.",
    });
    expect(await getRef(harness.idleCardRef)).toBeNull();
  });

  for (const scenario of [
    {
      name: "rolls back interruptRequested when interrupting fails",
      options: { interruptResult: "failure" as const, hasActiveRun: true },
      expectActiveRunInterrupted: false,
      expectedEdit: formatErrorResponse("## ❌ Failed to interrupt run", "interrupt failed"),
    },
  ]) {
    test(scenario.name, async () => {
      const harness = await runInteraction(await makeHarness(scenario.options), "interrupt");
      expect(harness.activeRun.interruptRequested).toBe(scenario.expectActiveRunInterrupted);
      expect(await getRef(harness.typingStopCount)).toBe(0);
      expect(await getRef(harness.replies)).toEqual([]);
      expect(await getRef(harness.edits)).toEqual([scenario.expectedEdit]);
    });
  }

  test("reports a lost interrupt when questions become pending right after the interrupt request succeeds", async () => {
    const harness = await runInteraction(
      await makeHarness({
        hasActiveRun: true,
        hasPendingQuestionsSequence: [false, true],
      }),
      "interrupt",
    );
    expect(harness.activeRun.interruptRequested).toBe(false);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([QUESTION_PENDING_INTERRUPT_MESSAGE]);
  });

  test("restores the compaction card when interrupting compaction fails", async () => {
    const harness = await makeHarness({
      interruptResult: "failure",
    });
    await runEffect(Ref.set(harness.idleCardRef, unsafeStub<Message>({ id: "compaction-card" })));
    await runEffect(Ref.set(harness.idleCompactionActive, true));

    await runInteraction(harness, "interrupt");
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
    const harness = await runInteraction(await makeHarness({ hasSession: false }), "new-session");
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
    const harness = await runInteraction(
      await makeHarness({
        hasSession: false,
        failInfoCardUpsert: true,
      }),
      "new-session",
    );
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
    await expect(runEffect(harness.runtime.handleInteraction(harness.interaction))).rejects.toThrow(
      "invalidate failed",
    );

    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([
      "An unexpected error occurred while processing this command.",
    ]);
  });

  test("rechecks busy state when /new-session loses the invalidate race", async () => {
    const harness = await runInteraction(
      await makeHarness({
        invalidateResult: "busy",
        hasPendingQuestionsSequence: [false, true],
      }),
      "new-session",
    );
    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.replies)).toEqual([]);
    expect(await getRef(harness.edits)).toEqual([QUESTION_PENDING_NEW_SESSION_MESSAGE]);
    expect(await getRef(harness.invalidatedSessions)).toEqual([]);
  });

  test("toggles thinking visibility for a channel without requiring a session", async () => {
    const harness = await runInteraction(
      await makeHarness({ hasSession: false }),
      "toggle-thinking",
    );
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
    const harness = await runInteraction(await makeHarness(), "toggle-compaction-summaries");
    expect(await getRef(harness.replies)).toEqual([
      "Compaction summaries are now disabled in this channel.",
    ]);
    expect(harness.session.channelSettings).toEqual({
      showThinking: true,
      showCompactionSummaries: false,
    });
  });
});
