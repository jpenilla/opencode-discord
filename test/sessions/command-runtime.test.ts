import { describe, expect, test } from "bun:test";
import { ChannelType, type Interaction, type Message, type SendableChannels } from "discord.js";
import { Deferred, Effect, Ref } from "effect";

import { formatErrorResponse } from "@/discord/formatting.ts";
import { createCommandRuntime } from "@/sessions/command-runtime.ts";
import { QUESTION_PENDING_INTERRUPT_MESSAGE } from "@/sessions/command-lifecycle.ts";
import { createPromptState } from "@/sessions/prompt-state.ts";
import { noQuestionOutcome, type ActiveRun, type ChannelSession } from "@/sessions/session.ts";
import type { PersistedChannelSettings } from "@/state/channel-settings.ts";
import { unsafeStub } from "../support/stub.ts";

const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref));

const makeHarness = async (options?: {
  sessionHealthy?: boolean;
  interruptResult?: "success" | "failure";
  hasActiveRun?: boolean;
  hasPendingQuestions?: boolean;
  hasPendingQuestionsSequence?: boolean[];
  hasSession?: boolean;
  initialChannelSettings?: PersistedChannelSettings | null;
}) => {
  const replies = await Effect.runPromise(Ref.make<string[]>([]));
  const defers = await Effect.runPromise(Ref.make(0));
  const edits = await Effect.runPromise(Ref.make<string[]>([]));
  const compactionUpdates = await Effect.runPromise(
    Ref.make<Array<{ title: string; body: string }>>([]),
  );
  const upsertedInfoCards = await Effect.runPromise(
    Ref.make<Array<{ title: string; body: string }>>([]),
  );
  const loggedWarnings = await Effect.runPromise(Ref.make<string[]>([]));
  const typingStopCount = await Effect.runPromise(Ref.make(0));
  const idleCardRef = await Effect.runPromise(Ref.make<Message | null>(null));
  const idleCompactionActive = await Effect.runPromise(Ref.make(false));
  const idleInterruptRequested = await Effect.runPromise(Ref.make(false));
  const persistedSettings = await Effect.runPromise(
    Ref.make<Map<string, PersistedChannelSettings>>(new Map()),
  );
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

  const compactionCard = unsafeStub<Message>({
    id: "compaction-card",
  });

  const activeRun: ActiveRun = {
    discordMessage: unsafeStub<Message>({
      id: "discord-message",
      channelId: "channel-1",
      channel: { id: "channel-1" },
      attachments: new Map(),
    }),
    workdir: "/home/opencode/workspace",
    attachmentMessagesById: new Map(),
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
    queue: {} as ChannelSession["queue"],
    activeRun: (options?.hasActiveRun ?? false) ? activeRun : null,
  };

  const interaction = unsafeStub<
    Interaction & {
      replied: boolean;
      deferred: boolean;
      commandName: string;
    }
  >({
    commandName: "compact",
    channelId: "channel-1",
    channel: unsafeStub<SendableChannels>({ type: ChannelType.GuildText, id: "channel-1" }),
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

  const runtime = createCommandRuntime({
    getSession: (channelId) =>
      Effect.succeed(
        (options?.hasSession ?? true) && channelId === session.channelId ? session : null,
      ),
    getLiveSession: (channelId) =>
      Effect.succeed(
        (options?.hasSession ?? true) && channelId === session.channelId ? session : null,
      ),
    getChannelSettings: (channelId) =>
      Ref.get(persistedSettings).pipe(Effect.map((current) => current.get(channelId) ?? null)),
    upsertChannelSettings: (settings) =>
      Ref.update(persistedSettings, (current) => {
        const next = new Map(current);
        next.set(settings.channelId, settings);
        return next;
      }),
    channelSettingsDefaults,
    hasIdleCompaction: () =>
      Effect.all([Ref.get(idleCompactionActive), Ref.get(idleCardRef)]).pipe(
        Effect.map(([active, card]) => active || card !== null),
      ),
    hasPendingQuestions: () =>
      Ref.updateAndGet(pendingQuestionCheckCount, (count) => count + 1).pipe(
        Effect.map((count) => {
          const sequence = options?.hasPendingQuestionsSequence;
          if (sequence && sequence.length > 0) {
            return sequence[Math.min(count - 1, sequence.length - 1)] ?? false;
          }
          return options?.hasPendingQuestions ?? false;
        }),
      ),
    getIdleCompactionCard: (_sessionId) => Ref.get(idleCardRef),
    beginIdleCompaction: () => Ref.set(idleCompactionActive, true),
    setIdleCompactionCard: (_sessionId, card) =>
      Ref.set(idleCardRef, card).pipe(
        Effect.zipRight(Ref.set(idleCompactionActive, card !== null)),
      ),
    setIdleCompactionInterruptRequested: (_sessionId, interruptRequested) =>
      Ref.set(idleInterruptRequested, interruptRequested),
    getIdleCompactionInterruptRequested: (_sessionId) => Ref.get(idleInterruptRequested),
    updateIdleCompactionCard: (_sessionId, title, body) =>
      Ref.get(idleCardRef).pipe(
        Effect.flatMap((card) =>
          card
            ? Ref.update(compactionUpdates, (current) => [...current, { title, body }]).pipe(
                Effect.asVoid,
              )
            : Effect.void,
        ),
      ),
    finalizeIdleCompactionCard: (_sessionId, title, body) =>
      Ref.set(idleCardRef, null).pipe(
        Effect.zipRight(Ref.set(idleCompactionActive, false)),
        Effect.zipRight(Ref.update(compactionUpdates, (current) => [...current, { title, body }])),
        Effect.zipRight(Deferred.succeed(compactUpdated, undefined).pipe(Effect.ignore)),
      ),
    isSessionHealthy: () => Effect.succeed(options?.sessionHealthy ?? true),
    compactSession: () =>
      Deferred.succeed(compactStarted, undefined).pipe(
        Effect.zipRight(Deferred.await(compactFinish)),
      ),
    interruptSession: () =>
      options?.interruptResult === "failure"
        ? Effect.fail(new Error("interrupt failed"))
        : Effect.void,
    upsertInfoCard: async ({ title, body }) => {
      await Effect.runPromise(
        Ref.update(upsertedInfoCards, (current) => [...current, { title, body }]),
      );
      return compactionCard;
    },
    logger: {
      info: () => Effect.void,
      warn: (message) => Ref.update(loggedWarnings, (current) => [...current, message]),
      error: () => Effect.void,
    },
    formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
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
    loggedWarnings,
    typingStopCount,
    idleCardRef,
    persistedSettings,
    compactStarted,
    compactFinish,
    compactUpdated,
  };
};

describe("createCommandRuntime", () => {
  test("rejects unhealthy compact requests after deferring", async () => {
    const harness = await makeHarness({
      sessionHealthy: false,
    });

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));

    expect(handled).toBe(true);
    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.edits)).toEqual([
      "This channel session is unavailable right now. Send a normal message to recreate it.",
    ]);
    expect(await getRef(harness.upsertedInfoCards)).toEqual([]);
  });

  test("starts compaction, posts the idle card, and clears it after completion", async () => {
    const harness = await makeHarness();

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));
    expect(handled).toBe(true);

    await Effect.runPromise(Deferred.await(harness.compactStarted));
    expect(await getRef(harness.defers)).toBe(1);
    expect(await getRef(harness.upsertedInfoCards)).toEqual([
      {
        title: "🗜️ Compacting session",
        body: "OpenCode is summarizing earlier context for this session.",
      },
    ]);
    expect((await getRef(harness.idleCardRef))?.id).toBe("compaction-card");
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

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));

    expect(handled).toBe(true);
    expect(harness.activeRun.interruptRequested).toBe(false);
    expect(await getRef(harness.edits)).toEqual([
      formatErrorResponse("## ❌ Failed to interrupt run", "interrupt failed"),
    ]);
  });

  test("requests interruption of the active run without claiming success yet", async () => {
    const harness = await makeHarness({
      hasActiveRun: true,
    });
    harness.interaction.commandName = "interrupt";

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));

    expect(handled).toBe(true);
    expect(harness.activeRun.interruptRequested).toBe(true);
    expect(await getRef(harness.typingStopCount)).toBe(0);
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

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));

    expect(handled).toBe(true);
    expect(harness.activeRun.interruptRequested).toBe(false);
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

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));

    expect(handled).toBe(true);
    expect(harness.activeRun.interruptRequested).toBe(false);
    expect(await getRef(harness.edits)).toEqual([QUESTION_PENDING_INTERRUPT_MESSAGE]);
  });

  test("interrupts an active compaction card without posting a run card", async () => {
    const harness = await makeHarness();
    harness.interaction.commandName = "interrupt";
    await Effect.runPromise(
      Ref.set(harness.idleCardRef, unsafeStub<Message>({ id: "compaction-card" })),
    );

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));

    expect(handled).toBe(true);
    expect(await getRef(harness.typingStopCount)).toBe(0);
    expect(await getRef(harness.compactionUpdates)).toEqual([
      {
        title: "‼️ Interrupting compaction",
        body: "OpenCode is stopping session compaction.",
      },
    ]);
    expect((await getRef(harness.idleCardRef))?.id).toBe("compaction-card");
    expect(await getRef(harness.edits)).toEqual([
      "Requested interruption of the active OpenCode compaction.",
    ]);
  });

  test("toggles thinking visibility for a channel without requiring a session", async () => {
    const harness = await makeHarness({
      hasSession: false,
    });
    harness.interaction.commandName = "toggle-thinking";

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));

    expect(handled).toBe(true);
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

  test("toggles compaction summary visibility and updates the live session", async () => {
    const harness = await makeHarness();
    harness.interaction.commandName = "toggle-compaction-summaries";

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction));

    expect(handled).toBe(true);
    expect(await getRef(harness.replies)).toEqual([
      "Compaction summaries are now disabled in this channel.",
    ]);
    expect(harness.session.channelSettings).toEqual({
      showThinking: true,
      showCompactionSummaries: false,
    });
  });
});
