import { describe, expect, test } from "bun:test"
import type { Event, QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { Chunk, Effect, Queue, Ref } from "effect"
import type { Message } from "discord.js"

import { createEventRuntime } from "@/sessions/event-runtime.ts"
import { noQuestionOutcome, type ActiveRun, type ChannelSession, type RunProgressEvent } from "@/sessions/session.ts"
import { unsafeStub } from "../support/stub.ts"

const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref))

const makeSession = async (withActiveRun: boolean) => {
  const progressQueue = await Effect.runPromise(Queue.unbounded<RunProgressEvent>())
  const activeRun = withActiveRun ? unsafeStub<ActiveRun>({
    discordMessage: unsafeStub<Message>({
      id: "discord-message",
      channelId: "channel-1",
      channel: { id: "channel-1" },
      attachments: new Map(),
    }),
    workdir: "/home/opencode/workspace",
    attachmentMessagesById: new Map(),
    progressQueue,
    followUpQueue: {} as ActiveRun["followUpQueue"],
    acceptFollowUps: {} as ActiveRun["acceptFollowUps"],
    typing: {
      pause: () => Promise.resolve(),
      resume: () => {},
      stop: () => Promise.resolve(),
    },
    questionOutcome: noQuestionOutcome(),
    interruptRequested: false,
  }) : null

  const session = unsafeStub<ChannelSession>({
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
    queue: {} as ChannelSession["queue"],
    activeRun,
  })

  return { session, activeRun, progressQueue }
}

const makeQuestionAskedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "question.asked",
    properties: {
      id: "req-1",
      sessionID: sessionId,
      questions: [{ header: "Question", question: "Question?", options: [{ label: "Yes", description: "desc" }] }],
      tool: {
        messageID: "message-1",
        callID: "call-1",
      },
    } satisfies QuestionRequest,
  })

const makeQuestionRepliedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "question.replied",
    properties: {
      sessionID: sessionId,
      requestID: "req-1",
      answers: [["Yes"]] satisfies ReadonlyArray<QuestionAnswer>,
    },
  })

const makeQuestionRejectedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "question.rejected",
    properties: {
      sessionID: sessionId,
      requestID: "req-1",
    },
  })

const makeSessionStatusEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: {
        type: "busy",
      },
    },
  })

const makeSessionCompactedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "session.compacted",
    properties: {
      sessionID: sessionId,
    },
  })

describe("createEventRuntime", () => {
  test("routes question asked events to the question runtime", async () => {
    const { session } = await makeSession(false)
    const questionEvents = await Effect.runPromise(Ref.make<unknown[]>([]))

    const runtime = createEventRuntime({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun: null } : null),
      handleQuestionEvent: (event) => Ref.update(questionEvents, (current) => [...current, event]),
      updateIdleCompactionCard: () => Effect.void,
    })

    await Effect.runPromise(runtime.handleEvent(makeQuestionAskedEvent()))

    expect(await getRef(questionEvents)).toEqual([{
      type: "asked",
      sessionId: "session-1",
      request: makeQuestionAskedEvent().properties,
    }])
  })

  test("routes question reply and rejection events to the question runtime", async () => {
    const { session } = await makeSession(false)
    const questionEvents = await Effect.runPromise(Ref.make<unknown[]>([]))

    const runtime = createEventRuntime({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun: null } : null),
      handleQuestionEvent: (event) => Ref.update(questionEvents, (current) => [...current, event]),
      updateIdleCompactionCard: () => Effect.void,
    })

    await Effect.runPromise(runtime.handleEvent(makeQuestionRepliedEvent()))
    await Effect.runPromise(runtime.handleEvent(makeQuestionRejectedEvent()))

    expect(await getRef(questionEvents)).toEqual([
      {
        type: "replied",
        sessionId: "session-1",
        requestId: "req-1",
        answers: [["Yes"]],
      },
      {
        type: "rejected",
        sessionId: "session-1",
        requestId: "req-1",
      },
    ])
  })

  test("enqueues progress events for active runs", async () => {
    const { session, activeRun, progressQueue } = await makeSession(true)

    const runtime = createEventRuntime({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      handleQuestionEvent: () => Effect.void,
      updateIdleCompactionCard: () => Effect.void,
    })

    await Effect.runPromise(runtime.handleEvent(makeSessionStatusEvent()))

    expect(Chunk.toReadonlyArray(await Effect.runPromise(Queue.takeAll(progressQueue)))).toEqual([{
      type: "session-status",
      status: { type: "busy" },
    }])
  })

  test("updates the idle compaction card when compaction finishes outside an active run", async () => {
    const { session } = await makeSession(false)
    const idleUpdates = await Effect.runPromise(Ref.make<Array<{ sessionId: string; title: string; body: string }>>([]))

    const runtime = createEventRuntime({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun: null } : null),
      handleQuestionEvent: () => Effect.void,
      updateIdleCompactionCard: (sessionId, title, body) =>
        Ref.update(idleUpdates, (current) => [...current, { sessionId, title, body }]),
    })

    await Effect.runPromise(runtime.handleEvent(makeSessionCompactedEvent()))

    expect(await getRef(idleUpdates)).toEqual([{
      sessionId: "session-1",
      title: "🗜️ Session compacted",
      body: "OpenCode summarized earlier context for this session.",
    }])
  })

  test("ignores events for sessions that are not currently tracked", async () => {
    const questionEvents = await Effect.runPromise(Ref.make(0))
    const idleUpdates = await Effect.runPromise(Ref.make(0))

    const runtime = createEventRuntime({
      getSessionContext: () => Effect.succeed(null),
      handleQuestionEvent: () => Ref.update(questionEvents, (count) => count + 1),
      updateIdleCompactionCard: () => Ref.update(idleUpdates, (count) => count + 1),
    })

    await Effect.runPromise(runtime.handleEvent(makeQuestionAskedEvent("missing-session")))
    await Effect.runPromise(runtime.handleEvent(makeSessionCompactedEvent("missing-session")))

    expect(await getRef(questionEvents)).toBe(0)
    expect(await getRef(idleUpdates)).toBe(0)
  })
})
