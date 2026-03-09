import { describe, expect, test } from "bun:test"
import type { Interaction, Message, MessageCreateOptions, MessageEditOptions } from "discord.js"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { Effect, Ref } from "effect"

import { createQuestionRuntime } from "@/sessions/question-runtime.ts"
import { noQuestionOutcome, type ActiveRun, type ChannelSession } from "@/sessions/session.ts"
import { unsafeStub } from "../support/stub.ts"

const makeRequest = (id = "req-1") =>
  unsafeStub<QuestionRequest>({
    id,
    questions: [{ header: "Question", question: "Question?", options: [{ label: "Yes", description: "desc" }] }],
  })

const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref))

const makeHarness = async (options?: {
  postQuestionResult?: "success" | "failure"
  rejectResult?: "success" | "failure"
}) => {
  const postedPayloads = await Effect.runPromise(Ref.make<MessageCreateOptions[]>([]))
  const editedPayloads = await Effect.runPromise(Ref.make<MessageEditOptions[]>([]))
  const interactionReplies = await Effect.runPromise(Ref.make<Array<{ content?: string | null }>>([]))
  const sentQuestionUiFailures = await Effect.runPromise(Ref.make<string[]>([]))
  const replyCalls = await Effect.runPromise(Ref.make<string[]>([]))
  const rejectCalls = await Effect.runPromise(Ref.make<string[]>([]))
  const typingPauseCount = await Effect.runPromise(Ref.make(0))
  const typingResumeCount = await Effect.runPromise(Ref.make(0))
  const typingStopCount = await Effect.runPromise(Ref.make(0))

  const questionMessage: Message = unsafeStub<Message>({
    id: "question-message",
    edit: (payload: MessageEditOptions): Promise<Message> =>
      Effect.runPromise(Ref.update(editedPayloads, (current) => [...current, payload])).then(() => questionMessage),
  })

  const discordMessage = unsafeStub<Message>({
    id: "discord-message",
    channelId: "channel-1",
    author: { id: "owner", tag: "owner#0001" },
    reply: (payload: MessageCreateOptions) =>
      Effect.runPromise(Ref.update(postedPayloads, (current) => [...current, payload])).then(() => {
        if (options?.postQuestionResult === "failure") {
          throw new Error("post failed")
        }
        return questionMessage
      }),
  })

  const activeRun: ActiveRun = {
    discordMessage,
    workdir: "/home/opencode/workspace",
    attachmentMessagesById: new Map(),
    progressQueue: {} as ActiveRun["progressQueue"],
    followUpQueue: {} as ActiveRun["followUpQueue"],
    acceptFollowUps: {} as ActiveRun["acceptFollowUps"],
    typing: {
      pause: () => Effect.runPromise(Ref.update(typingPauseCount, (count) => count + 1)),
      resume: () => {
        void Effect.runPromise(Ref.update(typingResumeCount, (count) => count + 1))
      },
      stop: () => Effect.runPromise(Ref.update(typingStopCount, (count) => count + 1)),
    },
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
    rootDir: "/tmp/root",
    workdir: "/home/opencode/workspace",
    queue: {} as ChannelSession["queue"],
    activeRun,
  }
  session.activeRun = activeRun

  const runtime = await Effect.runPromise(
    createQuestionRuntime({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      replyToQuestion: (_opencode, requestId, _answers) =>
        Ref.update(replyCalls, (current) => [...current, requestId]),
      rejectQuestion: (_opencode, requestId) =>
        Ref.update(rejectCalls, (current) => [...current, requestId]).pipe(
          Effect.flatMap(() =>
            options?.rejectResult === "failure" ? Effect.fail(new Error("reject failed")) : Effect.void,
          ),
        ),
      sendQuestionUiFailure: (_message, error) =>
        Ref.update(sentQuestionUiFailures, (current) => [...current, String(error)]),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    }),
  )

  const makeButtonInteraction = (input: {
    customId: string
    userId?: string
    messageId?: string
  }) =>
    unsafeStub<Interaction>({
      customId: input.customId,
      user: { id: input.userId ?? "owner" },
      message: { id: input.messageId ?? questionMessage.id },
      replied: false,
      deferred: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      reply: (payload: { content?: string | null }) =>
        Effect.runPromise(Ref.update(interactionReplies, (current) => [...current, payload])),
      update: (_payload: MessageEditOptions) => Promise.resolve(questionMessage),
      followUp: (_payload: unknown) => Promise.resolve(questionMessage),
      showModal: (_modal: unknown) => Promise.resolve(),
      deferUpdate: () => Promise.resolve(),
    })

  return {
    runtime,
    session,
    activeRun,
    questionMessage,
    request: makeRequest(),
    postedPayloads,
    editedPayloads,
    interactionReplies,
    sentQuestionUiFailures,
    replyCalls,
    rejectCalls,
    typingPauseCount,
    typingResumeCount,
    typingStopCount,
    makeButtonInteraction,
  }
}

describe("createQuestionRuntime", () => {
  test("posts a question batch once and resumes typing after a reply event", async () => {
    const harness = await makeHarness()

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    )
    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    )

    expect((await getRef(harness.postedPayloads)).length).toBe(1)
    expect(await getRef(harness.typingPauseCount)).toBe(1)

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "replied",
        sessionId: harness.session.opencode.sessionId,
        requestId: harness.request.id,
        answers: [["Yes"]] satisfies ReadonlyArray<QuestionAnswer>,
      }),
    )

    expect((await getRef(harness.editedPayloads)).length).toBe(1)
    expect(await getRef(harness.typingResumeCount)).toBe(1)
  })

  test("sends a UI failure reply when posting the question and rejecting it both fail", async () => {
    const harness = await makeHarness({
      postQuestionResult: "failure",
      rejectResult: "failure",
    })

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    )

    expect(await getRef(harness.rejectCalls)).toEqual([harness.request.id])
    expect(await getRef(harness.sentQuestionUiFailures)).toEqual(["post failed"])
    expect(await getRef(harness.typingStopCount)).toBe(1)
    expect(harness.activeRun.questionOutcome).toEqual({
      _tag: "ui-failure",
      message: "post failed",
      notified: true,
    })
  })

  test("rejects question interactions from other users", async () => {
    const harness = await makeHarness()

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    )

    const handled = await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: `ocq:${harness.request.id}:submit`,
          userId: "intruder",
        }),
      ),
    )

    expect(handled).toBe(true)
    expect((await getRef(harness.interactionReplies))[0]?.content).toBe(
      "Only the user who started this run can answer these questions.",
    )
  })

  test("expires question batches for a session and treats later interactions as expired", async () => {
    const harness = await makeHarness()

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    )

    await Effect.runPromise(harness.runtime.expireForSession(harness.session.opencode.sessionId))

    const handled = await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: `ocq:${harness.request.id}:submit`,
        }),
      ),
    )

    expect(handled).toBe(true)
    expect((await getRef(harness.editedPayloads)).length).toBe(1)
    expect((await getRef(harness.interactionReplies))[0]?.content).toBe("This question prompt has expired.")
  })
})
