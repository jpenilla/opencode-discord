import { describe, expect, test } from "bun:test"
import { ChannelType, type Interaction, type Message, type MessageCreateOptions, type MessageEditOptions, type SendableChannels } from "discord.js"
import { Deferred, Effect, Layer, Queue, Ref } from "effect"

import { AppConfig, type AppConfigShape } from "@/config.ts"
import { buildOpencodePrompt, buildQueuedFollowUpPrompt, promptMessageContext } from "@/discord/messages.ts"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { type OpencodeEventQueueShape, OpencodeEventQueue } from "@/opencode/events.ts"
import { type OpencodeServiceShape, OpencodeService, type PromptResult, type SessionHandle } from "@/opencode/service.ts"
import { ChannelSessions, ChannelSessionsLive } from "@/sessions/registry.ts"
import { Logger, type LoggerShape } from "@/util/logging.ts"
import { unsafeEffect, unsafeStub } from "../support/stub.ts"

const makeConfig = (): AppConfigShape => ({
  discordToken: "discord-token",
  triggerPhrase: "hey opencode",
  sessionInstructions: "",
  toolBridgeSocketPath: "/tmp/bridge.sock",
  toolBridgeToken: "bridge-token",
  sandboxBackend: "bwrap",
  opencodeBin: "opencode",
  bwrapBin: "bwrap",
  sandboxReadOnlyPaths: [],
  sandboxEnvPassthrough: [],
})

const makeLogger = (): LoggerShape => ({
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
})

const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref))

const waitForNoActiveRun = (sessions: { getActiveRunBySessionId: (sessionId: string) => Effect.Effect<unknown> }, sessionId: string) =>
  sessions.getActiveRunBySessionId(sessionId).pipe(
    Effect.flatMap((activeRun) => activeRun ? Effect.fail(new Error("run still active")) : Effect.void),
    Effect.eventually,
    Effect.timeoutFail({
      duration: "1 second",
      onTimeout: () => new Error(`Timed out waiting for active run ${sessionId} to clear`),
    }),
  )

const cardText = (payload: unknown) =>
  String((payload as { components?: Array<{ components?: Array<{ data?: { content?: string } }> }> })
    .components?.[0]?.components?.[0]?.data?.content ?? "")

const makeQuestionAskedEvent = (): GlobalEvent =>
  unsafeStub<GlobalEvent>({
    payload: {
      type: "question.asked",
      properties: {
        id: "req-1",
        sessionID: "session-1",
        questions: [{ header: "Question", question: "Question?", options: [{ label: "Yes", description: "desc" }] }],
        tool: {
          messageID: "assistant-1",
          callID: "call-1",
        },
      },
    },
  })

const makeQuestionRepliedEvent = (): GlobalEvent =>
  unsafeStub<GlobalEvent>({
    payload: {
      type: "question.replied",
      properties: {
        sessionID: "session-1",
        requestID: "req-1",
        answers: [["Yes"]],
      },
    },
  })

const makeHarness = async (options: {
  promptImpl: (input: { prompt: string; callIndex: number }) => Effect.Effect<PromptResult>
  isHealthyImpl?: () => Effect.Effect<boolean>
  createSessionImpl?: (input: { workdir: string; title: string; callIndex: number }) => Effect.Effect<SessionHandle>
  compactSessionImpl?: () => Effect.Effect<void>
  interruptSessionImpl?: () => Effect.Effect<void>
  rejectQuestionImpl?: () => Effect.Effect<void>
  failComponentReplies?: boolean
}) => {
  const replies = await Effect.runPromise(Ref.make<string[]>([]))
  const replyPayloads = await Effect.runPromise(Ref.make<unknown[]>([]))
  const sentPayloads = await Effect.runPromise(Ref.make<unknown[]>([]))
  const editedPayloads = await Effect.runPromise(Ref.make<unknown[]>([]))
  const typing = await Effect.runPromise(Ref.make(0))
  const promptCalls = await Effect.runPromise(Ref.make<string[]>([]))
  const createSessionCalls = await Effect.runPromise(Ref.make<Array<{ workdir: string; title: string }>>([]))
  const compactCalls = await Effect.runPromise(Ref.make(0))
  const interruptCalls = await Effect.runPromise(Ref.make(0))
  const createSessionCount = await Effect.runPromise(Ref.make(0))
  const replyEvents = await Effect.runPromise(Queue.unbounded<string>())
  const eventQueue = await Effect.runPromise(Queue.unbounded<GlobalEvent>())

  const makePostedMessage = (id: string): Message =>
    unsafeStub<Message>({
      id,
      edit: (payload: MessageEditOptions): Promise<Message> =>
        Effect.runPromise(Ref.update(editedPayloads, (current) => [...current, payload])).then(() => makePostedMessage(id)),
    })

  const sendOnChannel = (payload: MessageCreateOptions) =>
    Effect.runPromise(Ref.update(sentPayloads, (current) => [...current, payload])).then(() => {
      const content = payload.content
      if (content) {
        return Effect.runPromise(Queue.offer(replyEvents, String(content))).then(() => makePostedMessage(`sent-${Date.now()}`))
      }
      return makePostedMessage(`sent-${Date.now()}`)
    })

  const messageChannel = unsafeStub<SendableChannels>({
    id: "channel-1",
    type: ChannelType.DM,
    isSendable: () => true,
    sendTyping: () => Effect.runPromise(Ref.update(typing, (count) => count + 1)),
    send: sendOnChannel,
  })

  const commandChannel = unsafeStub<SendableChannels>({
    id: "channel-1",
    type: ChannelType.GuildText,
    isSendable: () => true,
    sendTyping: () => Effect.runPromise(Ref.update(typing, (count) => count + 1)),
    send: sendOnChannel,
  })

  const makeMessage = (input: {
    id: string
    channelId?: string
    content: string
  }) =>
    unsafeStub<Message>({
      id: input.id,
      channelId: input.channelId ?? "channel-1",
      content: input.content,
      author: {
        id: "user-1",
        tag: "user#0001",
        username: "user",
      },
      inGuild: () => false,
      attachments: new Map(),
      embeds: [],
      reference: null,
      member: null,
      guild: null,
      channel: messageChannel,
      reply: (payload: MessageCreateOptions) =>
        Effect.runPromise(Ref.update(replyPayloads, (current) => [...current, payload])).then(async () => {
          if (options.failComponentReplies && payload.components?.length) {
            throw new Error("question post failed")
          }
          if (payload.content) {
            await Effect.runPromise(Ref.update(replies, (current) => [...current, String(payload.content)]))
            await Effect.runPromise(Queue.offer(replyEvents, String(payload.content)))
          }
          return makePostedMessage(`reply-${input.id}`)
        }),
    })

  const makeCommandInteraction = (commandName: "compact" | "interrupt") => {
    const interactionReplies = Ref.unsafeMake<unknown[]>([])
    const interactionEdits = Ref.unsafeMake<unknown[]>([])
    const interactionDefers = Ref.unsafeMake(0)

    const interaction = unsafeStub<Interaction & {
      replied: boolean
      deferred: boolean
    }>({
      commandName,
      channelId: "channel-1",
      channel: commandChannel,
      replied: false,
      deferred: false,
      inGuild: () => true,
      isChatInputCommand: () => true,
      reply: (payload: unknown) => {
        interaction.replied = true
        return Effect.runPromise(Ref.update(interactionReplies, (current) => [...current, payload]))
      },
      deferReply: (_payload: unknown) => {
        interaction.deferred = true
        return Effect.runPromise(Ref.update(interactionDefers, (count) => count + 1))
      },
      editReply: (payload: unknown) =>
        Effect.runPromise(Ref.update(interactionEdits, (current) => [...current, payload])),
    })

    return {
      interaction,
      interactionReplies,
      interactionEdits,
      interactionDefers,
    }
  }

  const makeQuestionButtonInteraction = (input?: { userId?: string; messageId?: string }) => {
    const interactionReplies = Ref.unsafeMake<unknown[]>([])
    const interactionEdits = Ref.unsafeMake<unknown[]>([])

    const interaction = unsafeStub<Interaction & { replied: boolean; deferred: boolean }>({
      customId: "ocq:req-1:submit",
      user: { id: input?.userId ?? "intruder" },
      message: { id: input?.messageId ?? "reply-message-1" },
      replied: false,
      deferred: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      reply: (payload: unknown) => {
        interaction.replied = true
        return Effect.runPromise(Ref.update(interactionReplies, (current) => [...current, payload]))
      },
      update: (payload: unknown) =>
        Effect.runPromise(Ref.update(interactionEdits, (current) => [...current, payload])).then(() => makePostedMessage("reply-message-1")),
      followUp: (_payload: unknown) => Promise.resolve(makePostedMessage("reply-message-1")),
      showModal: (_payload: unknown) => Promise.resolve(),
      deferUpdate: () => Promise.resolve(),
    })

    return {
      interaction,
      interactionReplies,
      interactionEdits,
    }
  }

  const service: OpencodeServiceShape = {
    createSession: (workdir, title) =>
      Ref.updateAndGet(createSessionCount, (count) => count + 1).pipe(
        Effect.flatMap((callIndex) =>
          Ref.update(createSessionCalls, (current) => [...current, { workdir, title }]).pipe(
            Effect.zipRight(
              options.createSessionImpl?.({
                workdir,
                title,
                callIndex,
              }) ??
                Effect.succeed({
                  sessionId: `session-${callIndex}`,
                  client: {} as never,
                  workdir: "/home/opencode/workspace",
                  backend: "bwrap",
                  close: () => Effect.void,
                } as SessionHandle),
            ),
          ),
        ),
      ),
    prompt: (_session, prompt) =>
      Ref.updateAndGet(promptCalls, (current) => [...current, prompt]).pipe(
        Effect.flatMap((calls) =>
          options.promptImpl({
            prompt,
            callIndex: calls.length,
          }),
        ),
      ),
    interruptSession: () =>
      Ref.update(interruptCalls, (count) => count + 1).pipe(
        Effect.zipRight(options.interruptSessionImpl?.() ?? Effect.void),
      ),
    compactSession: () =>
      Ref.update(compactCalls, (count) => count + 1).pipe(
        Effect.zipRight(options.compactSessionImpl?.() ?? Effect.void),
      ),
    replyToQuestion: () => Effect.void,
    rejectQuestion: () => options.rejectQuestionImpl?.() ?? Effect.void,
    isHealthy: () => options.isHealthyImpl?.() ?? Effect.succeed(true),
  }

  const deps = Layer.mergeAll(
    Layer.succeed(AppConfig, makeConfig()),
    Layer.succeed(Logger, makeLogger()),
    Layer.succeed(OpencodeService, service),
    Layer.succeed(OpencodeEventQueue, {
      publish: (event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid),
      take: () => Queue.take(eventQueue),
    } satisfies OpencodeEventQueueShape),
  )
  const layer = Layer.merge(
    deps,
    ChannelSessionsLive.pipe(Layer.provide(deps)),
  )

  return {
    replies,
    replyPayloads,
    replyEvents,
    sentPayloads,
    editedPayloads,
    typing,
    promptCalls,
    createSessionCalls,
    compactCalls,
    interruptCalls,
    layer,
    makeMessage,
    makeCommandInteraction,
    makeQuestionButtonInteraction,
    publishEvent: (event: GlobalEvent) => Effect.runPromise(Queue.offer(eventQueue, event)).then(() => undefined),
  }
}

describe("ChannelSessionsLive integration", () => {
  test("submits a message, prompts opencode, and replies with the final response", async () => {
    const harness = await makeHarness({
      promptImpl: () =>
        Effect.succeed({
          messageId: "assistant-1",
          transcript: "done",
        }),
    })
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions
          yield* sessions.submit(message, { prompt: "hello" })
          expect(yield* Queue.take(harness.replyEvents)).toBe("done")
        }).pipe(Effect.provide(harness.layer)),
      ),
    )

    expect(await getRef(harness.promptCalls)).toEqual([
      buildOpencodePrompt({
        message: promptMessageContext(message, "hello"),
      }),
    ])
    expect(await getRef(harness.replies)).toEqual(["done"])
    expect(await getRef(harness.createSessionCalls)).toHaveLength(1)
  })

  test("absorbs follow-up messages into the active run and re-prompts opencode", async () => {
    const firstPromptStarted = await Effect.runPromise(Deferred.make<void>())
    const allowFirstPromptToFinish = await Effect.runPromise(Deferred.make<void>())
    const harness = await makeHarness({
      promptImpl: ({ prompt, callIndex }) =>
        callIndex === 1
          ? Deferred.succeed(firstPromptStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(allowFirstPromptToFinish)),
              Effect.as({
                messageId: "assistant-1",
                transcript: "intermediate",
              }),
            )
          : Effect.succeed({
              messageId: "assistant-2",
              transcript: `final:${prompt}`,
            }),
    })
    const firstMessage = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    })
    const secondMessage = harness.makeMessage({
      id: "message-2",
      content: "hey opencode follow up",
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions
          yield* sessions.submit(firstMessage, { prompt: "hello" })
          yield* Deferred.await(firstPromptStarted)
          yield* sessions.submit(secondMessage, { prompt: "follow up" })
          yield* Deferred.succeed(allowFirstPromptToFinish, undefined).pipe(Effect.ignore)
          yield* Queue.take(harness.replyEvents)
        }).pipe(Effect.provide(harness.layer)),
      ),
    )

    expect(await getRef(harness.promptCalls)).toEqual([
      buildOpencodePrompt({
        message: promptMessageContext(firstMessage, "hello"),
      }),
      buildQueuedFollowUpPrompt([
        buildOpencodePrompt({
          message: promptMessageContext(secondMessage, "follow up"),
        }),
      ]),
    ])
    expect(await getRef(harness.replies)).toEqual([
      `final:${buildQueuedFollowUpPrompt([
        buildOpencodePrompt({
          message: promptMessageContext(secondMessage, "follow up"),
        }),
      ])}`,
    ])
  })

  test("runs /compact through the live layer and posts a channel info card", async () => {
    const compactStarted = await Effect.runPromise(Deferred.make<void>())
    const allowCompactToFinish = await Effect.runPromise(Deferred.make<void>())
    const harness = await makeHarness({
      promptImpl: () =>
        Effect.succeed({
          messageId: "assistant-1",
          transcript: "done",
        }),
      compactSessionImpl: () =>
        Deferred.succeed(compactStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowCompactToFinish)),
        ),
    })
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    })
    const command = harness.makeCommandInteraction("compact")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions
          yield* sessions.submit(message, { prompt: "hello" })
          yield* Queue.take(harness.replyEvents)
          yield* waitForNoActiveRun(sessions, "session-1")
          yield* sessions.handleInteraction(command.interaction)
          yield* Deferred.await(compactStarted)
          yield* Deferred.succeed(allowCompactToFinish, undefined).pipe(Effect.ignore)
          yield* Effect.promise(() => Bun.sleep(0))
        }).pipe(Effect.provide(harness.layer)),
      ),
    )

    expect(await getRef(harness.compactCalls)).toBe(1)
    expect(await getRef(command.interactionDefers)).toBe(1)
    expect(await getRef(command.interactionEdits)).toEqual([
      {
        content: "Started session compaction. I'll post updates in this channel.",
        allowedMentions: { parse: [] },
      },
    ])
    expect((await getRef(harness.sentPayloads)).map(cardText)).toContain(
      "**🗜️ Compacting session**\nOpenCode is summarizing earlier context for this session.",
    )
    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain(
      "**🗜️ Session compacted**\nOpenCode summarized earlier context for this session.",
    )
  })

  test("runs /interrupt through the live layer and stops the active run", async () => {
    const promptStarted = await Effect.runPromise(Deferred.make<void>())
    const interruptRequested = await Effect.runPromise(Deferred.make<void>())
    const promptFinished = await Effect.runPromise(Deferred.make<void>())
    const harness = await makeHarness({
      promptImpl: () =>
        unsafeEffect(Effect.gen(function* () {
          yield* Deferred.succeed(promptStarted, undefined)
          yield* Deferred.await(interruptRequested)
          return yield* Effect.fail(new Error("interrupted"))
        }).pipe(
          Effect.ensuring(Deferred.succeed(promptFinished, undefined).pipe(Effect.ignore)),
        )),
      interruptSessionImpl: () =>
        Deferred.succeed(interruptRequested, undefined).pipe(Effect.asVoid),
    })
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    })
    const command = harness.makeCommandInteraction("interrupt")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions
          yield* sessions.submit(message, { prompt: "hello" })
          yield* Deferred.await(promptStarted)
          yield* sessions.handleInteraction(command.interaction)
          yield* Deferred.await(promptFinished)
        }).pipe(Effect.provide(harness.layer)),
      ),
    )

    expect(await getRef(harness.interruptCalls)).toBe(1)
    expect(await getRef(command.interactionDefers)).toBe(1)
    expect(await getRef(command.interactionEdits)).toEqual([
      {
        content: "Interrupted the active OpenCode run.",
        allowedMentions: { parse: [] },
      },
    ])
    expect(await getRef(harness.replies)).toEqual([])
    expect((await getRef(harness.sentPayloads)).map(cardText)).toContain(
      "**🛑 Run interrupted**\nOpenCode stopped the active run in this channel.",
    )
  })

  test("recreates an unhealthy session after a failed run and succeeds on the next submit", async () => {
    const healthy = await Effect.runPromise(Ref.make(true))
    const createSessionCount = await Effect.runPromise(Ref.make(0))
    const harness = await makeHarness({
      promptImpl: ({ callIndex }) =>
        callIndex === 1
          ? unsafeEffect(Effect.gen(function* () {
              yield* Ref.set(healthy, false)
              return yield* Effect.fail(new Error("boom"))
            }))
          : Effect.succeed({
              messageId: "assistant-2",
              transcript: "recovered",
            }),
      isHealthyImpl: () => Ref.get(healthy),
      createSessionImpl: ({ callIndex, workdir }) =>
        Ref.update(createSessionCount, (count) => count + 1).pipe(
          Effect.zipRight(Ref.set(healthy, true)),
          Effect.as({
            sessionId: `session-${callIndex}`,
            client: {} as never,
            workdir,
            backend: "bwrap",
            close: () => Effect.void,
          } as SessionHandle),
        ),
    })
    const firstMessage = harness.makeMessage({
      id: "message-1",
      content: "hey opencode first",
    })
    const secondMessage = harness.makeMessage({
      id: "message-2",
      content: "hey opencode second",
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions
          yield* sessions.submit(firstMessage, { prompt: "first" })
          expect(yield* Queue.take(harness.replyEvents)).toContain("Opencode failed")
          yield* waitForNoActiveRun(sessions, "session-1")
          yield* sessions.submit(secondMessage, { prompt: "second" })
          expect(yield* Queue.take(harness.replyEvents)).toBe("recovered")
        }).pipe(Effect.provide(harness.layer)),
      ),
    )

    expect(await getRef(createSessionCount)).toBe(2)
    expect(await getRef(harness.createSessionCalls)).toHaveLength(2)
    expect(await getRef(harness.promptCalls)).toEqual([
      buildOpencodePrompt({
        message: promptMessageContext(firstMessage, "first"),
      }),
      buildOpencodePrompt({
        message: promptMessageContext(secondMessage, "second"),
      }),
    ])
  })

  test("processes queued question events through the live layer and finalizes the question card", async () => {
    const promptStarted = await Effect.runPromise(Deferred.make<void>())
    const allowPromptToFinish = await Effect.runPromise(Deferred.make<void>())
    const harness = await makeHarness({
      promptImpl: () =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowPromptToFinish)),
          Effect.as({
            messageId: "assistant-1",
            transcript: "question complete",
          }),
        ),
    })
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions
          yield* sessions.submit(message, { prompt: "hello" })
          yield* Deferred.await(promptStarted)
          yield* Effect.promise(() => harness.publishEvent(makeQuestionAskedEvent()))
          yield* Effect.promise(() => Bun.sleep(10))
          yield* Effect.promise(() => harness.publishEvent(makeQuestionRepliedEvent()))
          yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore)
          expect(yield* Queue.take(harness.replyEvents)).toBe("question complete")
        }).pipe(Effect.provide(harness.layer)),
      ),
    )

    expect((await getRef(harness.replyPayloads)).map(cardText)).toContain("**❓ Questions need answers**\nQuestion 1/1 • 0/1 answered • Pick one • Other allowed • 1 option")
    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain("**✅ Questions answered**\n1 question")
  })

  test("routes question interactions through the live layer after command handling falls through", async () => {
    const promptStarted = await Effect.runPromise(Deferred.make<void>())
    const allowPromptToFinish = await Effect.runPromise(Deferred.make<void>())
    const harness = await makeHarness({
      promptImpl: () =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowPromptToFinish)),
          Effect.as({
            messageId: "assistant-1",
            transcript: "done",
          }),
        ),
    })
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    })
    const questionInteraction = harness.makeQuestionButtonInteraction()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions
          yield* sessions.submit(message, { prompt: "hello" })
          yield* Deferred.await(promptStarted)
          yield* Effect.promise(() => harness.publishEvent(makeQuestionAskedEvent()))
          yield* Effect.promise(() => Bun.sleep(10))
          const handled = yield* sessions.handleInteraction(questionInteraction.interaction)
          expect(handled).toBe(true)
          yield* Effect.promise(() => harness.publishEvent(makeQuestionRepliedEvent()))
          yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore)
          yield* Queue.take(harness.replyEvents)
        }).pipe(Effect.provide(harness.layer)),
      ),
    )

    expect(await getRef(questionInteraction.interactionReplies)).toEqual([
      {
        content: "Only the user who started this run can answer these questions.",
        flags: 64,
        allowedMentions: { parse: [] },
      },
    ])
  })

  test("surfaces a question UI failure reply when posting the question card fails", async () => {
    const promptStarted = await Effect.runPromise(Deferred.make<void>())
    const allowPromptToFinish = await Effect.runPromise(Deferred.make<void>())
    const harness = await makeHarness({
      promptImpl: () =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowPromptToFinish)),
          Effect.as({
            messageId: "assistant-1",
            transcript: "",
          }),
        ),
      failComponentReplies: true,
    })
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions
          yield* sessions.submit(message, { prompt: "hello" })
          yield* Deferred.await(promptStarted)
          yield* Effect.promise(() => harness.publishEvent(makeQuestionAskedEvent()))
          yield* sessions.getActiveRunBySessionId("session-1").pipe(
            Effect.flatMap((activeRun) =>
              activeRun && activeRun.questionOutcome._tag === "ui-failure"
                ? Effect.void
                : Effect.fail(new Error("question UI failure not recorded yet")),
            ),
            Effect.eventually,
            Effect.timeoutFail({
              duration: "1 second",
              onTimeout: () => new Error("Timed out waiting for the live question UI failure state"),
            }),
          )
          yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore)
          expect(yield* Queue.take(harness.replyEvents)).toContain("Failed to show questions")
        }).pipe(Effect.provide(harness.layer)),
      ),
    )

    expect(await getRef(harness.replies)).toHaveLength(1)
    expect((await getRef(harness.replyPayloads)).some((payload) => cardText(payload).includes("❓ Questions need answers"))).toBe(true)
  })
})
