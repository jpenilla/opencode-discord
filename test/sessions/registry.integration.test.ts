import { describe, expect, test } from "bun:test"
import { ChannelType, type Message, type MessageCreateOptions, type SendableChannels } from "discord.js"
import { Deferred, Effect, Layer, Ref } from "effect"

import { AppConfig, type AppConfigShape } from "@/config.ts"
import { buildOpencodePrompt, buildQueuedFollowUpPrompt, promptMessageContext } from "@/discord/messages.ts"
import { OpencodeEventQueueLive } from "@/opencode/events.ts"
import { type OpencodeServiceShape, OpencodeService, type PromptResult, type SessionHandle } from "@/opencode/service.ts"
import { ChannelSessions, ChannelSessionsLive } from "@/sessions/registry.ts"
import { Logger, type LoggerShape } from "@/util/logging.ts"

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

const makeSessionHandle = (): SessionHandle =>
  ({
    sessionId: "session-1",
    client: {} as never,
    workdir: "/home/opencode/workspace",
    backend: "bwrap",
    close: () => Effect.void,
  }) as SessionHandle

const makeMessage = (input: {
  id: string
  channelId?: string
  content: string
  prompt?: string
  replyRef: Ref.Ref<string[]>
  sentRef: Ref.Ref<string[]>
  typingRef: Ref.Ref<number>
  replySent: Deferred.Deferred<void>
}) =>
  ({
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
    channel: {
      id: input.channelId ?? "channel-1",
      type: ChannelType.DM,
      isSendable: () => true,
      sendTyping: () => Effect.runPromise(Ref.update(input.typingRef, (count) => count + 1)),
      send: ({ content }: MessageCreateOptions) =>
        Effect.runPromise(Ref.update(input.sentRef, (current) => [...current, String(content ?? "")])),
    } as unknown as SendableChannels,
    reply: ({ content }: MessageCreateOptions) =>
      Effect.runPromise(
        Ref.update(input.replyRef, (current) => [...current, String(content ?? "")]).pipe(
          Effect.zipRight(Deferred.succeed(input.replySent, undefined).pipe(Effect.ignore)),
        ),
      ),
  }) as unknown as Message

const makeHarness = async (promptImpl: (input: { prompt: string; callIndex: number }) => Effect.Effect<PromptResult>) => {
  const replies = await Effect.runPromise(Ref.make<string[]>([]))
  const sent = await Effect.runPromise(Ref.make<string[]>([]))
  const typing = await Effect.runPromise(Ref.make(0))
  const promptCalls = await Effect.runPromise(Ref.make<string[]>([]))
  const createSessionCalls = await Effect.runPromise(Ref.make<Array<{ workdir: string; title: string }>>([]))
  const replySent = await Effect.runPromise(Deferred.make<void>())

  const service: OpencodeServiceShape = {
    createSession: (workdir, title) =>
      Ref.update(createSessionCalls, (current) => [...current, { workdir, title }]).pipe(
        Effect.as(makeSessionHandle()),
      ),
    prompt: (_session, prompt) =>
      Ref.updateAndGet(promptCalls, (current) => [...current, prompt]).pipe(
        Effect.flatMap((calls) =>
          promptImpl({
            prompt,
            callIndex: calls.length,
          }),
        ),
      ),
    interruptSession: () => Effect.void,
    compactSession: () => Effect.void,
    replyToQuestion: () => Effect.void,
    rejectQuestion: () => Effect.void,
    isHealthy: () => Effect.succeed(true),
  }

  const deps = Layer.mergeAll(
    Layer.succeed(AppConfig, makeConfig()),
    Layer.succeed(Logger, makeLogger()),
    Layer.succeed(OpencodeService, service),
    OpencodeEventQueueLive,
  )
  const layer = ChannelSessionsLive.pipe(Layer.provide(deps))

  return {
    replies,
    sent,
    typing,
    promptCalls,
    createSessionCalls,
    replySent,
    layer,
    makeMessage: (input: { id: string; content: string; prompt?: string }) =>
      makeMessage({
        ...input,
        replyRef: replies,
        sentRef: sent,
        typingRef: typing,
        replySent,
      }),
  }
}

describe("ChannelSessionsLive integration", () => {
  test("submits a message, prompts opencode, and replies with the final response", async () => {
    const harness = await makeHarness(() =>
      Effect.succeed({
        messageId: "assistant-1",
        transcript: "done",
      }),
    )
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions
          yield* sessions.submit(message, { prompt: "hello" })
          yield* Deferred.await(harness.replySent)
        }).pipe(Effect.provide(harness.layer)),
      ),
    )

    expect(await Effect.runPromise(Ref.get(harness.promptCalls))).toEqual([
      buildOpencodePrompt({
        message: promptMessageContext(message, "hello"),
      }),
    ])
    expect(await Effect.runPromise(Ref.get(harness.replies))).toEqual(["done"])
    expect(await Effect.runPromise(Ref.get(harness.createSessionCalls))).toHaveLength(1)
  })

  test("absorbs follow-up messages into the active run and re-prompts opencode", async () => {
    const firstPromptStarted = await Effect.runPromise(Deferred.make<void>())
    const allowFirstPromptToFinish = await Effect.runPromise(Deferred.make<void>())
    const harness = await makeHarness(({ prompt, callIndex }) =>
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
    )
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
          yield* Deferred.await(harness.replySent)
        }).pipe(Effect.provide(harness.layer)),
      ),
    )

    expect(await Effect.runPromise(Ref.get(harness.promptCalls))).toEqual([
      buildOpencodePrompt({
        message: promptMessageContext(firstMessage, "hello"),
      }),
      buildQueuedFollowUpPrompt([
        buildOpencodePrompt({
          message: promptMessageContext(secondMessage, "follow up"),
        }),
      ]),
    ])
    expect(await Effect.runPromise(Ref.get(harness.replies))).toEqual([
      `final:${buildQueuedFollowUpPrompt([
        buildOpencodePrompt({
          message: promptMessageContext(secondMessage, "follow up"),
        }),
      ])}`,
    ])
  })
})
