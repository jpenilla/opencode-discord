import { describe, expect, test } from "bun:test";
import { ChannelType, type Message, type SendableChannels } from "discord.js";
import { Deferred, Effect, Layer, Queue } from "effect";

import {
  QUESTION_PENDING_INTERRUPT_MESSAGE,
  QUESTION_PENDING_NEW_SESSION_MESSAGE,
} from "@/channels/command-policy.ts";
import { createCommandHandler } from "@/channels/command-handler.ts";
import { AppConfig, type AppConfigShape } from "@/config.ts";
import { InfoCards, type InfoCardsShape } from "@/discord/info-card.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import {
  type IdleCompactionWorkflowShape,
  type IdleCompactionWorkflowInterruptResult,
  type IdleCompactionWorkflowStartResult,
} from "@/sessions/compaction/idle-compaction-workflow.ts";
import {
  type ChannelActivity,
  SessionRuntime,
  type SessionRuntimeShape,
} from "@/sessions/session-runtime.ts";
import { type ActiveRun, type ChannelSession, type RunRequest } from "@/sessions/session.ts";
import type { PersistedChannelSettings } from "@/state/channel-settings.ts";
import { StatePersistence, type StatePersistenceShape } from "@/state/persistence.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";
import { makeRecordedCommandInteraction, makeSendableChannel } from "../support/discord.ts";
import { makeMessage, makeSessionHandle } from "../support/fixtures.ts";
import { makeTestConfig } from "../support/config.ts";
import { failTest } from "../support/errors.ts";
import { appendRef, makeDeferred, runTestEffect } from "../support/runtime.ts";
import { makeTestActiveRun, makeTestSession } from "../support/session.ts";
import { unsafeStub } from "../support/stub.ts";

const runEffect = runTestEffect;

const makeConfig = (defaults: {
  showThinking: boolean;
  showCompactionSummaries: boolean;
}): AppConfigShape =>
  makeTestConfig({
    showThinkingByDefault: defaults.showThinking,
    showCompactionSummariesByDefault: defaults.showCompactionSummaries,
    sandboxBackend: "bwrap",
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
  sessionRuntime: SessionRuntimeShape;
  statePersistence: StatePersistenceShape;
  infoCards: InfoCardsShape;
  logger: LoggerShape;
  config: AppConfigShape;
}) =>
  Layer.mergeAll(
    Layer.succeed(AppConfig, deps.config),
    Layer.succeed(StatePersistence, deps.statePersistence),
    Layer.succeed(SessionRuntime, deps.sessionRuntime),
    Layer.succeed(InfoCards, deps.infoCards),
    Layer.succeed(Logger, deps.logger),
  );

const makeHarness = async (options?: HarnessOptions) => {
  const replies: string[] = [];
  const edits: string[] = [];
  let defers = 0;
  const compactionUpdates: Array<{ title: string; body: string }> = [];
  const upsertedInfoCards: Array<{ title: string; body: string }> = [];
  let typingStopCount = 0;
  let idleCard: Message | null = null;
  let idleCompactionActive = options?.hasIdleCompaction ?? false;
  let idleInterruptRequested = false;
  const persistedSettings = new Map<string, PersistedChannelSettings>();
  const invalidatedSessions: Array<{ channelId: string; reason: string }> = [];
  const warnings: string[] = [];
  const compactStarted = await makeDeferred<void>();
  const compactFinish = await makeDeferred<void>();
  const compactUpdated = await makeDeferred<void>();
  let pendingQuestionCheckCount = 0;
  const channelSettingsDefaults = {
    showThinking: true,
    showCompactionSummaries: true,
  } as const;

  if (options?.initialChannelSettings) {
    persistedSettings.set(options.initialChannelSettings.channelId, options.initialChannelSettings);
  }

  const sessionQueue = await runEffect(Queue.unbounded<RunRequest>());
  if (options?.hasQueuedWork) {
    await runEffect(Queue.offer(sessionQueue, {} as RunRequest));
  }

  const { activeRun } = await makeTestActiveRun({
    originMessage: makeMessage({
      id: "discord-message",
      channelId: "channel-1",
      channel: { id: "channel-1" },
    }),
    typing: {
      pause: async () => {},
      resume: () => {},
      stop: async () => {
        typingStopCount += 1;
      },
    },
  });

  const session: ChannelSession = makeTestSession({
    opencode: makeSessionHandle({
      sessionId: "session-1",
      client: {} as never,
    }),
    channelSettings: {
      showThinking:
        options?.initialChannelSettings?.showThinking ?? channelSettingsDefaults.showThinking,
      showCompactionSummaries:
        options?.initialChannelSettings?.showCompactionSummaries ??
        channelSettingsDefaults.showCompactionSummaries,
    },
    queue: sessionQueue,
    activeRun: (options?.hasActiveRun ?? false) ? activeRun : null,
  });

  let currentSession: ChannelSession | null = (options?.hasSession ?? true) ? session : null;

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
        upsertedInfoCards.push({ title, body });
        if (title === "🗜️ Compacting session") {
          idleCard = card;
        }
        return card;
      }),
  };

  const logger: LoggerShape = {
    info: () => Effect.void,
    warn: (message) =>
      Effect.sync(() => {
        warnings.push(message);
      }),
    error: () => Effect.void,
  };

  const statePersistence: StatePersistenceShape = {
    getSession: () => Effect.succeed(null),
    upsertSession: () => Effect.void,
    touchSession: () => Effect.void,
    deleteSession: () => Effect.void,
    getChannelSettings: (channelId: string) =>
      Effect.succeed(persistedSettings.get(channelId) ?? null),
    upsertChannelSettings: (settings: PersistedChannelSettings) =>
      Effect.sync(() => {
        persistedSettings.set(settings.channelId, settings);
      }),
  };

  const idleCompactionWorkflow: IdleCompactionWorkflowShape = {
    hasActive: () => Effect.succeed(idleCompactionActive),
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
        idleCompactionActive = true;
        yield* Deferred.succeed(compactStarted, undefined);

        yield* Effect.sync(() => {
          void runEffect(
            Deferred.await(compactFinish).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  compactionUpdates.push({
                    title: "🗜️ Session compacted",
                    body: "OpenCode summarized earlier context for this session.",
                  });
                  idleCard = null;
                  idleCompactionActive = false;
                }),
              ),
              Effect.andThen(Deferred.succeed(compactUpdated, undefined)),
            ),
          );
        });

        return { type: "started" } satisfies IdleCompactionWorkflowStartResult;
      }),
    requestInterrupt: () =>
      Effect.gen(function* () {
        idleInterruptRequested = true;
        compactionUpdates.push({
          title: "‼️ Interrupting compaction",
          body: "OpenCode is stopping session compaction.",
        });

        if (options?.interruptResult === "failure") {
          compactionUpdates.push({
            title: "🗜️ Compacting session",
            body: "OpenCode is summarizing earlier context for this session.",
          });
          idleInterruptRequested = false;
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
    Effect.succeed(
      currentSession && currentSession.channelId === channelId ? currentSession : null,
    );

  const readChannelActivity = (
    currentSession: ChannelSession | null,
  ): Effect.Effect<ChannelActivity> => {
    if (!currentSession) {
      return Effect.succeed({ type: "missing" });
    }
    return Effect.all({
      idleCompactionBusy: Effect.succeed(idleCompactionActive),
      queueSize: Queue.size(currentSession.queue),
      pendingQuestionCheckCount: Effect.sync(() => {
        pendingQuestionCheckCount += 1;
        return pendingQuestionCheckCount;
      }),
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

  const sessionRuntime: SessionRuntimeShape = {
    readLoadedChannelActivity: (channelId: string) =>
      readSession(channelId).pipe(Effect.flatMap(readChannelActivity)),
    readRestoredChannelActivity: (channelId: string) =>
      readSession(channelId).pipe(Effect.flatMap(readChannelActivity)),
    getActiveRunBySessionId: () => Effect.succeed(null),
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
        invalidatedSessions.push({ channelId: session.channelId, reason });
        if (currentSession?.channelId === channelId) {
          currentSession = null;
        }
        return true;
      }),
    updateLoadedChannelSettings: (channelId: string, settings) =>
      Effect.sync(() => {
        if (currentSession && currentSession.channelId === channelId) {
          currentSession.channelSettings = settings;
        }
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
    sessionRuntime,
    statePersistence,
    infoCards,
    logger,
    config: makeConfig(channelSettingsDefaults),
  });

  const runtime = createCommandHandler({
    commandLayer: commandsLayer,
  });

  const { interaction, readDefers } = makeRecordedCommandInteraction({
    commandName: "compact",
    channel: makeSendableChannel({ id: "channel-1", type: ChannelType.GuildText }),
    onReply: async (payload) => {
      replies.push((payload as { content?: string }).content ?? "");
    },
    onDeferReply: async () => {
      defers += 1;
    },
    onEditReply: async (payload) => {
      edits.push((payload as { content?: string }).content ?? "");
    },
  });

  return {
    runtime,
    session,
    interaction,
    activeRun,
    replies,
    readDefers,
    edits,
    compactionUpdates,
    upsertedInfoCards,
    readTypingStopCount: () => typingStopCount,
    readIdleCard: () => idleCard,
    setIdleCard: (card: Message | null) => {
      idleCard = card;
    },
    setIdleCompactionActive: (value: boolean) => {
      idleCompactionActive = value;
    },
    invalidatedSessions,
    warnings,
    persistedSettings,
    compactStarted,
    compactFinish,
    compactUpdated,
    readIdleInterruptRequested: () => idleInterruptRequested,
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

const expectDeferredEdit = async (
  harness: Awaited<ReturnType<typeof makeHarness>>,
  expectedEdit: string,
) => {
  expect(harness.readDefers()).toBe(1);
  expect(harness.replies).toEqual([]);
  expect(harness.edits).toEqual([expectedEdit]);
};

const freshSessionMessage =
  "Cleared this channel's current OpenCode session. The next triggered message here will start a new session with fresh chat history. Workspace files were left in place.";

describe("createCommandHandler", () => {
  test("rejects unhealthy compact requests after deferring", async () => {
    const harness = await runInteraction(await makeHarness({ sessionHealthy: false }), "compact");
    await expectDeferredEdit(
      harness,
      "This channel session is unavailable right now. Send a normal message to recreate it.",
    );
    expect(harness.upsertedInfoCards).toEqual([]);
  });

  test("starts compaction, posts the idle card, and clears it after completion", async () => {
    const harness = await runInteraction(await makeHarness(), "compact");
    await runEffect(Deferred.await(harness.compactStarted));
    expect(harness.readDefers()).toBe(1);
    expect(harness.upsertedInfoCards).toEqual([
      {
        title: "🗜️ Compacting session",
        body: "OpenCode is summarizing earlier context for this session.",
      },
    ]);
    expect(harness.readIdleCard()?.id).toBe("🗜️ Compacting session-channel-1");
    await expectDeferredEdit(
      harness,
      "Started session compaction. I'll post updates in this channel.",
    );

    await runEffect(Deferred.succeed(harness.compactFinish, undefined));
    await runEffect(Deferred.await(harness.compactUpdated));

    expect(harness.compactionUpdates).toContainEqual({
      title: "🗜️ Session compacted",
      body: "OpenCode summarized earlier context for this session.",
    });
    expect(harness.readIdleCard()).toBeNull();
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
      expect(harness.readTypingStopCount()).toBe(0);
      await expectDeferredEdit(harness, scenario.expectedEdit);
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
    await expectDeferredEdit(harness, QUESTION_PENDING_INTERRUPT_MESSAGE);
  });

  test("restores the compaction card when interrupting compaction fails", async () => {
    const harness = await makeHarness({
      interruptResult: "failure",
    });
    harness.setIdleCard(unsafeStub<Message>({ id: "compaction-card" }));
    harness.setIdleCompactionActive(true);

    await runInteraction(harness, "interrupt");
    expect(harness.readIdleInterruptRequested()).toBe(false);
    expect(harness.compactionUpdates).toEqual([
      {
        title: "‼️ Interrupting compaction",
        body: "OpenCode is stopping session compaction.",
      },
      {
        title: "🗜️ Compacting session",
        body: "OpenCode is summarizing earlier context for this session.",
      },
    ]);
    expect(harness.readIdleCard()?.id).toBe("compaction-card");
    await expectDeferredEdit(
      harness,
      formatErrorResponse("## ❌ Failed to interrupt compaction", "interrupt failed"),
    );
  });

  test("clears the channel session for the next triggered message", async () => {
    const harness = await runInteraction(await makeHarness({ hasSession: false }), "new-session");
    expect(harness.invalidatedSessions).toEqual([
      {
        channelId: "channel-1",
        reason: "requested a fresh session via /new-session",
      },
    ]);
    expect(harness.upsertedInfoCards).toEqual([
      {
        title: "🆕 Fresh session ready",
        body: "The next triggered message in this channel will start a new OpenCode session with fresh chat history. Workspace files were left in place.",
      },
    ]);
    await expectDeferredEdit(harness, freshSessionMessage);
  });

  test("logs and still replies when the fresh session info card cannot be posted", async () => {
    const harness = await runInteraction(
      await makeHarness({
        hasSession: false,
        failInfoCardUpsert: true,
      }),
      "new-session",
    );
    await expectDeferredEdit(harness, freshSessionMessage);
    expect(harness.warnings).toEqual(["failed to post fresh session info card"]);
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

    await expectDeferredEdit(
      harness,
      "An unexpected error occurred while processing this command.",
    );
  });

  test("rechecks busy state when /new-session loses the invalidate race", async () => {
    const harness = await runInteraction(
      await makeHarness({
        invalidateResult: "busy",
        hasPendingQuestionsSequence: [false, true],
      }),
      "new-session",
    );
    await expectDeferredEdit(harness, QUESTION_PENDING_NEW_SESSION_MESSAGE);
    expect(harness.invalidatedSessions).toEqual([]);
  });

  test("toggles thinking visibility for a channel without requiring a session", async () => {
    const harness = await runInteraction(
      await makeHarness({ hasSession: false }),
      "toggle-thinking",
    );
    expect(harness.replies).toEqual(["Thinking messages are now disabled in this channel."]);
    expect(harness.persistedSettings).toEqual(
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
    expect(harness.replies).toEqual(["Compaction summaries are now disabled in this channel."]);
    expect(harness.session.channelSettings).toEqual({
      showThinking: true,
      showCompactionSummaries: false,
    });
  });
});
