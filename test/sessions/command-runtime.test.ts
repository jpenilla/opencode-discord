import { describe, expect, test } from "bun:test"
import { ChannelType, type Interaction, type Message, type MessageEditOptions, type SendableChannels } from "discord.js"
import { Deferred, Effect, Ref } from "effect"

import { formatErrorResponse } from "@/discord/formatting.ts"
import { createCommandRuntime } from "@/sessions/command-runtime.ts"
import { noQuestionOutcome, type ActiveRun, type ChannelSession } from "@/sessions/session.ts"
import { unsafeStub } from "../support/stub.ts"

const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref))

const makeHarness = async (options?: {
  sessionHealthy?: boolean
  interruptResult?: "success" | "failure"
  hasActiveRun?: boolean
}) => {
  const replies = await Effect.runPromise(Ref.make<string[]>([]))
  const defers = await Effect.runPromise(Ref.make(0))
  const edits = await Effect.runPromise(Ref.make<string[]>([]))
  const compactionUpdates = await Effect.runPromise(Ref.make<Array<{ title: string; body: string }>>([]))
  const sentInfoCards = await Effect.runPromise(Ref.make<Array<{ title: string; body: string }>>([]))
  const upsertedInfoCards = await Effect.runPromise(Ref.make<Array<{ title: string; body: string }>>([]))
  const loggedWarnings = await Effect.runPromise(Ref.make<string[]>([]))
  const typingStopCount = await Effect.runPromise(Ref.make(0))
  const idleCardRef = await Effect.runPromise(Ref.make<Message | null>(null))
  const compactStarted = await Effect.runPromise(Deferred.make<void, never>())
  const compactFinish = await Effect.runPromise(Deferred.make<void, never>())
  const compactUpdated = await Effect.runPromise(Deferred.make<void, never>())

  const compactionCard = unsafeStub<Message>({
    id: "compaction-card",
  })

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
  }

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
    queue: {} as ChannelSession["queue"],
    activeRun: options?.hasActiveRun ?? false ? activeRun : null,
  }

  const interaction = unsafeStub<Interaction & {
    replied: boolean
    deferred: boolean
    commandName: string
  }>({
    commandName: "compact",
    channelId: "channel-1",
    channel: unsafeStub<SendableChannels>({ type: ChannelType.GuildText, id: "channel-1" }),
    replied: false,
    deferred: false,
    inGuild: () => true,
    isChatInputCommand: () => true,
    reply: ({ content }: { content?: string }) => {
      interaction.replied = true
      return Effect.runPromise(Ref.update(replies, (current) => [...current, content ?? ""]))
    },
    deferReply: () => {
      interaction.deferred = true
      return Effect.runPromise(Ref.update(defers, (count) => count + 1))
    },
    editReply: ({ content }: { content?: string }) =>
      Effect.runPromise(Ref.update(edits, (current) => [...current, content ?? ""])),
  })

  const runtime = createCommandRuntime({
    getSession: (channelId) => Effect.succeed(channelId === session.channelId ? session : null),
    getIdleCompactionCard: (_sessionId) => Ref.get(idleCardRef),
    setIdleCompactionCard: (_sessionId, card) => Ref.set(idleCardRef, card),
    updateIdleCompactionCard: (_sessionId, title, body) =>
      Ref.update(compactionUpdates, (current) => [...current, { title, body }]).pipe(
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
      await Effect.runPromise(Ref.update(upsertedInfoCards, (current) => [...current, { title, body }]))
      return compactionCard
    },
    editInfoCard: async (_message, title, body) => {
      await Effect.runPromise(Ref.update(compactionUpdates, (current) => [...current, { title, body }]))
    },
    sendInfoCard: async (_channel, title, body) => {
      await Effect.runPromise(Ref.update(sentInfoCards, (current) => [...current, { title, body }]))
    },
    logger: {
      info: () => Effect.void,
      warn: (message) => Ref.update(loggedWarnings, (current) => [...current, message]),
      error: () => Effect.void,
    },
    formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  })

  return {
    runtime,
    session,
    interaction,
    activeRun,
    replies,
    defers,
    edits,
    compactionUpdates,
    sentInfoCards,
    upsertedInfoCards,
    loggedWarnings,
    typingStopCount,
    idleCardRef,
    compactStarted,
    compactFinish,
    compactUpdated,
  }
}

describe("createCommandRuntime", () => {
  test("rejects unhealthy compact requests after deferring", async () => {
    const harness = await makeHarness({
      sessionHealthy: false,
    })

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction))

    expect(handled).toBe(true)
    expect(await getRef(harness.defers)).toBe(1)
    expect(await getRef(harness.edits)).toEqual([
      "This channel session is unavailable right now. Send a normal message to recreate it.",
    ])
    expect(await getRef(harness.upsertedInfoCards)).toEqual([])
  })

  test("starts compaction, posts the idle card, and clears it after completion", async () => {
    const harness = await makeHarness()

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction))
    expect(handled).toBe(true)

    await Effect.runPromise(Deferred.await(harness.compactStarted))
    expect(await getRef(harness.defers)).toBe(1)
    expect(await getRef(harness.upsertedInfoCards)).toEqual([
      {
        title: "🗜️ Compacting session",
        body: "OpenCode is summarizing earlier context for this session.",
      },
    ])
    expect((await getRef(harness.idleCardRef))?.id).toBe("compaction-card")
    expect(await getRef(harness.edits)).toEqual([
      "Started session compaction. I'll post updates in this channel.",
    ])

    await Effect.runPromise(Deferred.succeed(harness.compactFinish, undefined))
    await Effect.runPromise(Deferred.await(harness.compactUpdated))

    expect(await getRef(harness.compactionUpdates)).toContainEqual({
      title: "🗜️ Session compacted",
      body: "OpenCode summarized earlier context for this session.",
    })
    expect(await getRef(harness.idleCardRef)).toBeNull()
  })

  test("rolls back interruptRequested when interrupting fails", async () => {
    const harness = await makeHarness({
      interruptResult: "failure",
      hasActiveRun: true,
    })
    harness.interaction.commandName = "interrupt"

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction))

    expect(handled).toBe(true)
    expect(harness.activeRun.interruptRequested).toBe(false)
    expect(await getRef(harness.edits)).toEqual([
      formatErrorResponse("## ❌ Failed to interrupt run", "interrupt failed"),
    ])
    expect(await getRef(harness.sentInfoCards)).toEqual([])
  })

  test("interrupts the active run, stops typing, and posts a visible info card", async () => {
    const harness = await makeHarness({
      hasActiveRun: true,
    })
    harness.interaction.commandName = "interrupt"

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction))

    expect(handled).toBe(true)
    expect(harness.activeRun.interruptRequested).toBe(true)
    expect(await getRef(harness.typingStopCount)).toBe(1)
    expect(await getRef(harness.sentInfoCards)).toEqual([
      {
        title: "‼️ Run interrupted",
        body: "OpenCode stopped the active run in this channel.",
      },
    ])
    expect(await getRef(harness.edits)).toEqual([
      "Interrupted the active OpenCode run.",
    ])
  })

  test("interrupts an active compaction card without posting a run card", async () => {
    const harness = await makeHarness()
    harness.interaction.commandName = "interrupt"
    await Effect.runPromise(Ref.set(harness.idleCardRef, unsafeStub<Message>({ id: "compaction-card" })))

    const handled = await Effect.runPromise(harness.runtime.handleInteraction(harness.interaction))

    expect(handled).toBe(true)
    expect(await getRef(harness.typingStopCount)).toBe(0)
    expect(await getRef(harness.sentInfoCards)).toEqual([])
    expect(await getRef(harness.compactionUpdates)).toEqual([
      {
        title: "‼️ Compaction interrupted",
        body: "OpenCode stopped compacting this session because the run was interrupted.",
      },
    ])
    expect(await getRef(harness.idleCardRef)).toBeNull()
    expect(await getRef(harness.edits)).toEqual([
      "Interrupted the active OpenCode compaction.",
    ])
  })
})
