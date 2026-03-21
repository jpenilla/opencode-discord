import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelType,
  type Interaction,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  type SendableChannels,
} from "discord.js";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Queue, Ref } from "effect";

import { AppConfig, type AppConfigShape } from "@/config.ts";
import {
  ChannelRuntime,
  ChannelRuntimeLayer,
  type ChannelRuntimeShape,
} from "@/channels/channel-runtime.ts";
import { InfoCardsLayer } from "@/discord/info-card.ts";
import {
  buildOpencodePrompt,
  buildQueuedFollowUpPrompt,
  promptMessageContext,
} from "@/discord/messages.ts";
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2";
import { OpencodeEventQueue } from "@/opencode/events.ts";
import {
  type OpencodeServiceShape,
  OpencodeService,
  type PromptResult,
  type SessionHandle,
} from "@/opencode/service.ts";
import type { PersistedChannelSettings } from "@/state/channel-settings.ts";
import {
  type PersistedChannelSession,
  StatePersistence,
  type StatePersistenceShape,
} from "@/state/persistence.ts";
import {
  SessionRuntime,
  SessionRuntimeLayer,
  type SessionRuntimeShape,
} from "@/sessions/session-runtime.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";
import {
  makeAssistantMessageUpdatedEvent,
  makeQuestionAskedEvent,
  makeQuestionRepliedEvent,
  makeSessionCompactedEvent,
  makeUserMessageUpdatedEvent,
  toGlobalEvent,
} from "../support/opencode-events.ts";
import { getRef } from "../support/fixtures.ts";
import { makeTestConfig } from "../support/config.ts";
import { failTest, interruptedTestError, timeoutTestError } from "../support/errors.ts";
import { appendRef, runTestEffect } from "../support/runtime.ts";
import { unsafeEffect, unsafeStub } from "../support/stub.ts";

const TEST_STATE_DIR = join(tmpdir(), `.opencode-discord-test-storage-${process.pid}`);

const runEffect = runTestEffect;
const makeRef = <A>(value: A) => runEffect(Ref.make(value));
const makeDeferred = <A = void, E = never>() => runEffect(Deferred.make<A, E>());
const updateMapRef = <K, V>(ref: Ref.Ref<Map<K, V>>, update: (current: Map<K, V>) => void) =>
  Ref.update(ref, (current) => {
    const next = new Map(current);
    update(next);
    return next;
  });

const makeConfig = (): AppConfigShape =>
  makeTestConfig({
    stateDir: TEST_STATE_DIR,
    toolBridgeSocketPath: "/tmp/bridge.sock",
    sandboxBackend: "bwrap",
  });

beforeAll(async () => {
  await rm(TEST_STATE_DIR, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(TEST_STATE_DIR, { recursive: true, force: true });
});

const makeLogger = (): LoggerShape => ({
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
});

const pushRef = appendRef;
const promptFor = (message: Message, prompt: string) =>
  buildOpencodePrompt({ message: promptMessageContext(message, prompt) });
const queuedPromptFor = (message: Message, prompt: string) =>
  buildQueuedFollowUpPrompt([promptFor(message, prompt)]);

const waitForNoActiveRun = (
  sessions: { getActiveRunBySessionId: (sessionId: string) => Effect.Effect<unknown, unknown> },
  sessionId: string,
) =>
  sessions.getActiveRunBySessionId(sessionId).pipe(
    Effect.flatMap((activeRun) => (activeRun ? failTest("run still active") : Effect.void)),
    Effect.eventually,
    Effect.timeoutOrElse({
      duration: "1 second",
      onTimeout: () =>
        Effect.fail(timeoutTestError(`Timed out waiting for active run ${sessionId} to clear`)),
    }),
  );

const cardText = (payload: unknown) =>
  String(
    (payload as { components?: Array<{ components?: Array<{ data?: { content?: string } }> }> })
      .components?.[0]?.components?.[0]?.data?.content ?? "",
  );

const waitForReplyPayload = (
  replyPayloads: Ref.Ref<unknown[]>,
  predicate: (payload: unknown) => boolean,
) =>
  Ref.get(replyPayloads).pipe(
    Effect.flatMap((payloads) =>
      payloads.some(predicate) ? Effect.void : failTest("payload not posted yet"),
    ),
    Effect.eventually,
    Effect.timeoutOrElse({
      duration: "1 second",
      onTimeout: () => Effect.fail(timeoutTestError("Timed out waiting for reply payload")),
    }),
  );

const globalEvent = (event: Event): GlobalEvent => toGlobalEvent(event);

const makeToolUpdatedEvent = (input: {
  sessionId?: string;
  messageId: string;
  status: "running" | "error";
  callId?: string;
}): GlobalEvent =>
  unsafeStub<GlobalEvent>({
    payload: {
      type: "message.part.updated",
      properties: {
        part: {
          id: `part-${input.status}`,
          sessionID: input.sessionId ?? "session-1",
          messageID: input.messageId,
          type: "tool",
          callID: input.callId ?? "call-1",
          tool: "bash",
          state:
            input.status === "running"
              ? {
                  status: "running",
                  input: {
                    command: "pwd",
                  },
                  title: "Print cwd",
                  time: {
                    start: 1,
                  },
                }
              : {
                  status: "error",
                  input: {
                    command: "pwd",
                  },
                  error: "aborted",
                  time: {
                    start: 1,
                    end: 2,
                  },
                },
        },
      },
    },
  });

const makeSessionIdleEvent = (sessionId = "session-1"): GlobalEvent =>
  unsafeStub<GlobalEvent>({
    payload: {
      type: "session.status",
      properties: {
        sessionID: sessionId,
        status: {
          type: "idle",
        },
      },
    },
  });

type Harness = Awaited<ReturnType<typeof makeHarness>>;
type RuntimeServices = {
  channels: ChannelRuntimeShape;
  sessions: Pick<SessionRuntimeShape, "getActiveRunBySessionId">;
};

const makePromptMessage = (
  harness: Harness,
  input: { id: string; prompt: string; channelId?: string },
) =>
  harness.makeMessage({
    id: input.id,
    channelId: input.channelId,
    content: `hey opencode ${input.prompt}`,
  });

const submitPrompt = (channels: ChannelRuntimeShape, message: Message, prompt: string) =>
  channels.submit(message, { prompt });

const expectReplyEvents = (replyEvents: Queue.Dequeue<string>, expected: string[]) =>
  Effect.forEach(expected, (reply) =>
    Queue.take(replyEvents).pipe(
      Effect.tap((actual) => Effect.sync(() => expect(actual).toBe(reply))),
    ),
  ).pipe(Effect.asVoid);

const publishHarnessEvent = (harness: Harness, event: Event | GlobalEvent) =>
  Effect.promise(() => harness.publishEvent(event));

const waitForQuestionCard = (replyPayloads: Ref.Ref<unknown[]>) =>
  waitForReplyPayload(replyPayloads, (payload) =>
    cardText(payload).includes("❓ Questions need answers"),
  );

const nextTick = () => Effect.promise(() => Bun.sleep(0));
const shortDelay = () => Effect.promise(() => Bun.sleep(10));

const withHarness = <A>(
  harness: Harness,
  run: (services: RuntimeServices) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
) =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const channels = yield* ChannelRuntime;
        const sessions = yield* SessionRuntime;
        return yield* run({
          channels,
          sessions,
        });
      }).pipe(Effect.provide(harness.harnessLayer)),
    ),
  );

const makeHarness = async (options: {
  promptImpl: (input: {
    prompt: string;
    callIndex: number;
    messageId: string;
    sessionId: string;
    publishEvent: (event: Event | GlobalEvent) => Effect.Effect<void, never>;
    storePromptResult: (result: PromptResult) => Effect.Effect<void>;
    completePrompt: (result: PromptResult) => Effect.Effect<void>;
  }) => Effect.Effect<void, unknown>;
  isHealthyImpl?: () => Effect.Effect<boolean>;
  createSessionImpl?: (input: {
    workdir: string;
    title: string;
    callIndex: number;
  }) => Effect.Effect<SessionHandle>;
  compactSessionImpl?: () => Effect.Effect<void, unknown>;
  interruptSessionImpl?: () => Effect.Effect<void, unknown>;
  rejectQuestionImpl?: () => Effect.Effect<void>;
  failComponentReplies?: boolean;
  failChannelSend?: boolean;
}) => {
  const [
    replies,
    replyPayloads,
    replyTargetIds,
    sentPayloads,
    editedPayloads,
    typing,
    promptCalls,
    createSessionCalls,
    compactCalls,
    interruptCalls,
    createSessionCount,
    replyEvents,
    eventQueue,
    promptResults,
    persistedSessions,
    persistedSettings,
  ] = await runEffect(
    Effect.all([
      Ref.make<string[]>([]),
      Ref.make<unknown[]>([]),
      Ref.make<string[]>([]),
      Ref.make<unknown[]>([]),
      Ref.make<unknown[]>([]),
      Ref.make(0),
      Ref.make<string[]>([]),
      Ref.make<Array<{ workdir: string; title: string }>>([]),
      Ref.make(0),
      Ref.make(0),
      Ref.make(0),
      Queue.unbounded<string>(),
      Queue.unbounded<GlobalEvent>(),
      Ref.make<Map<string, PromptResult>>(new Map()),
      Ref.make<Map<string, PersistedChannelSession>>(new Map()),
      Ref.make<Map<string, PersistedChannelSettings>>(new Map()),
    ]),
  );

  const makePostedMessage = (id: string): Message =>
    unsafeStub<Message>({
      id,
      edit: (payload: MessageEditOptions): Promise<Message> =>
        runEffect(pushRef(editedPayloads, payload)).then(() => makePostedMessage(id)),
    });

  const sendOnChannel = (payload: MessageCreateOptions) =>
    runEffect(pushRef(sentPayloads, payload)).then(() => {
      if (options.failChannelSend) {
        throw new Error("channel send failed");
      }
      const content = payload.content;
      if (content) {
        return runEffect(Queue.offer(replyEvents, String(content))).then(() =>
          makePostedMessage(`sent-${Date.now()}`),
        );
      }
      return makePostedMessage(`sent-${Date.now()}`);
    });

  const messageChannel = unsafeStub<SendableChannels>({
    id: "channel-1",
    type: ChannelType.DM,
    isSendable: () => true,
    sendTyping: () => runEffect(Ref.update(typing, (count) => count + 1)),
    send: sendOnChannel,
  });

  const publishEvent = (event: Event | GlobalEvent) =>
    Queue.offer(eventQueue, "payload" in event ? event : globalEvent(event)).pipe(Effect.asVoid);

  const storePromptResult = (result: PromptResult) =>
    updateMapRef(promptResults, (current) => current.set(result.messageId, result));

  const completePrompt = (sessionId: string, userMessageId: string, result: PromptResult) =>
    storePromptResult(result).pipe(
      Effect.andThen(
        publishEvent(
          makeAssistantMessageUpdatedEvent({
            id: result.messageId,
            sessionId,
            parentId: userMessageId,
          }),
        ),
      ),
      Effect.andThen(publishEvent(makeSessionIdleEvent(sessionId))),
    );

  const commandChannel = unsafeStub<SendableChannels>({
    id: "channel-1",
    type: ChannelType.GuildText,
    isSendable: () => true,
    sendTyping: () => runEffect(Ref.update(typing, (count) => count + 1)),
    send: sendOnChannel,
  });

  const makeMessage = (input: { id: string; channelId?: string; content: string }) =>
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
        runEffect(pushRef(replyTargetIds, input.id)).then(() =>
          runEffect(pushRef(replyPayloads, payload)).then(async () => {
            if (options.failComponentReplies && payload.components?.length) {
              throw new Error("question post failed");
            }
            if (payload.content) {
              await runEffect(pushRef(replies, String(payload.content)));
              await runEffect(Queue.offer(replyEvents, String(payload.content)));
            }
            return makePostedMessage(`reply-${input.id}`);
          }),
        ),
    });

  const makeCommandInteraction = async (
    commandName:
      | "compact"
      | "interrupt"
      | "new-session"
      | "toggle-thinking"
      | "toggle-compaction-summaries",
  ) => {
    const [interactionReplies, interactionEdits, interactionDefers] = await runEffect(
      Effect.all([Ref.make<unknown[]>([]), Ref.make<unknown[]>([]), Ref.make(0)]),
    );

    const interaction = unsafeStub<
      Interaction & {
        replied: boolean;
        deferred: boolean;
      }
    >({
      commandName,
      channelId: "channel-1",
      channel: commandChannel,
      replied: false,
      deferred: false,
      inGuild: () => true,
      isChatInputCommand: () => true,
      reply: (payload: unknown) => {
        interaction.replied = true;
        return runEffect(pushRef(interactionReplies, payload));
      },
      deferReply: (_payload: unknown) => {
        interaction.deferred = true;
        return runEffect(Ref.update(interactionDefers, (count) => count + 1));
      },
      editReply: (payload: unknown) => runEffect(pushRef(interactionEdits, payload)),
    });

    return {
      interaction,
      interactionReplies,
      interactionEdits,
      interactionDefers,
    };
  };

  const makeQuestionButtonInteraction = async (input?: { userId?: string; messageId?: string }) => {
    const [interactionReplies, interactionEdits] = await runEffect(
      Effect.all([Ref.make<unknown[]>([]), Ref.make<unknown[]>([])]),
    );

    const interaction = unsafeStub<Interaction & { replied: boolean; deferred: boolean }>({
      customId: "ocq:req-1:0:submit",
      user: { id: input?.userId ?? "intruder" },
      message: { id: input?.messageId ?? "reply-message-1" },
      replied: false,
      deferred: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      reply: (payload: unknown) => {
        interaction.replied = true;
        return runEffect(pushRef(interactionReplies, payload));
      },
      update: (payload: unknown) =>
        runEffect(pushRef(interactionEdits, payload)).then(() =>
          makePostedMessage("reply-message-1"),
        ),
      followUp: (_payload: unknown) => Promise.resolve(makePostedMessage("reply-message-1")),
      showModal: (_payload: unknown) => Promise.resolve(),
      deferUpdate: () => Promise.resolve(),
    });

    return {
      interaction,
      interactionReplies,
      interactionEdits,
    };
  };

  const service: OpencodeServiceShape = {
    createSession: (workdir, title) =>
      Ref.updateAndGet(createSessionCount, (count) => count + 1).pipe(
        Effect.flatMap((callIndex) =>
          pushRef(createSessionCalls, { workdir, title }).pipe(
            Effect.andThen(
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
    attachSession: (workdir, sessionId) =>
      Effect.succeed({
        sessionId,
        client: {} as never,
        workdir,
        backend: "bwrap",
        close: () => Effect.void,
      } as SessionHandle),
    submitPrompt: (_session, prompt) =>
      Ref.updateAndGet(promptCalls, (current) => [...current, prompt]).pipe(
        Effect.flatMap((calls) =>
          Effect.gen(function* () {
            const messageId = `user-${calls.length}`;
            yield* publishEvent(
              makeUserMessageUpdatedEvent({
                id: messageId,
                sessionId: _session.sessionId,
              }),
            );
            yield* options.promptImpl({
              prompt,
              callIndex: calls.length,
              messageId,
              sessionId: _session.sessionId,
              publishEvent,
              storePromptResult,
              completePrompt: (result) => completePrompt(_session.sessionId, messageId, result),
            });
          }),
        ),
      ),
    readPromptResult: (_session, messageId) =>
      Ref.get(promptResults).pipe(
        Effect.map((results) => {
          const result = results.get(messageId);
          if (!result) {
            throw new Error(`missing prompt result ${messageId}`);
          }
          return result;
        }),
      ),
    interruptSession: () =>
      Ref.update(interruptCalls, (count) => count + 1).pipe(
        Effect.andThen(options.interruptSessionImpl?.() ?? Effect.void),
      ),
    compactSession: () =>
      Ref.update(compactCalls, (count) => count + 1).pipe(
        Effect.andThen(options.compactSessionImpl?.() ?? Effect.void),
      ),
    replyToQuestion: () => Effect.void,
    rejectQuestion: () => options.rejectQuestionImpl?.() ?? Effect.void,
    isHealthy: () => options.isHealthyImpl?.() ?? Effect.succeed(true),
  };

  const statePersistence: StatePersistenceShape = {
    getSession: (channelId) =>
      Ref.get(persistedSessions).pipe(Effect.map((sessions) => sessions.get(channelId) ?? null)),
    upsertSession: (session) =>
      updateMapRef(persistedSessions, (current) => current.set(session.channelId, session)),
    touchSession: (channelId, lastActivityAt) =>
      updateMapRef(persistedSessions, (current) => {
        const session = current.get(channelId);
        if (session) {
          current.set(channelId, {
            ...session,
            lastActivityAt,
          });
        }
      }),
    deleteSession: (channelId) =>
      updateMapRef(persistedSessions, (current) => current.delete(channelId)),
    getChannelSettings: (channelId) =>
      Ref.get(persistedSettings).pipe(Effect.map((settings) => settings.get(channelId) ?? null)),
    upsertChannelSettings: (settings) =>
      updateMapRef(persistedSettings, (current) => current.set(settings.channelId, settings)),
  };

  const deps = Layer.mergeAll(
    Layer.succeed(AppConfig, makeConfig()),
    InfoCardsLayer,
    Layer.succeed(Logger, makeLogger()),
    Layer.succeed(OpencodeService, service),
    Layer.succeed(StatePersistence, statePersistence),
    Layer.succeed(OpencodeEventQueue, eventQueue),
  );
  const sessionRuntimeLayer = SessionRuntimeLayer.pipe(Layer.provide(deps));
  const harnessLayer = Layer.mergeAll(
    deps,
    sessionRuntimeLayer,
    ChannelRuntimeLayer.pipe(Layer.provide(Layer.mergeAll(deps, sessionRuntimeLayer))),
  );

  return {
    replies,
    replyPayloads,
    replyTargetIds,
    replyEvents,
    sentPayloads,
    editedPayloads,
    typing,
    promptCalls,
    createSessionCalls,
    compactCalls,
    interruptCalls,
    harnessLayer,
    makeMessage,
    makeCommandInteraction,
    makeQuestionButtonInteraction,
    storePromptResult: (result: PromptResult) =>
      runEffect(storePromptResult(result)).then(() => undefined),
    publishEvent: (event: Event | GlobalEvent) =>
      runEffect(publishEvent(event)).then(() => undefined),
  };
};

describe("ChannelRuntimeLayer integration", () => {
  test("submits a message, prompts opencode, and replies with the final response", async () => {
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        completePrompt({
          messageId: "assistant-1",
          transcript: "done",
        }),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* expectReplyEvents(harness.replyEvents, ["done"]);
      }),
    );

    expect(await getRef(harness.promptCalls)).toEqual([promptFor(message, "hello")]);
    expect(await getRef(harness.replies)).toEqual(["done"]);
    expect(await getRef(harness.createSessionCalls)).toHaveLength(1);
  });

  test("absorbs follow-up messages into the active run and re-prompts opencode", async () => {
    const firstPromptStarted = await makeDeferred();
    const allowFirstPromptToFinish = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({ prompt, callIndex, completePrompt }) =>
        callIndex === 1
          ? Deferred.succeed(firstPromptStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowFirstPromptToFinish)),
              Effect.andThen(
                completePrompt({
                  messageId: "assistant-1",
                  transcript: "intermediate",
                }),
              ),
            )
          : completePrompt({
              messageId: "assistant-2",
              transcript: `final:${prompt}`,
            }),
    });
    const firstMessage = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const secondMessage = makePromptMessage(harness, { id: "message-2", prompt: "follow up" });

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, firstMessage, "hello");
        yield* Deferred.await(firstPromptStarted);
        yield* submitPrompt(channels, secondMessage, "follow up");
        yield* Deferred.succeed(allowFirstPromptToFinish, undefined).pipe(Effect.ignore);
        yield* expectReplyEvents(harness.replyEvents, [
          "intermediate",
          `final:${queuedPromptFor(secondMessage, "follow up")}`,
        ]);
      }),
    );

    expect(await getRef(harness.promptCalls)).toEqual([
      promptFor(firstMessage, "hello"),
      queuedPromptFor(secondMessage, "follow up"),
    ]);
    expect(await getRef(harness.replies)).toEqual([
      "intermediate",
      `final:${queuedPromptFor(secondMessage, "follow up")}`,
    ]);
    expect(await getRef(harness.replyTargetIds)).toEqual(["message-1", "message-2"]);
  });

  test("keeps the active run open after the final assistant update until session.status idle arrives", async () => {
    const assistantFinished = await makeDeferred();
    const allowIdleStatus = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({
        callIndex,
        completePrompt,
        messageId,
        publishEvent,
        sessionId,
        storePromptResult,
        prompt,
      }) =>
        callIndex === 1
          ? storePromptResult({
              messageId: "assistant-1",
              transcript: "intermediate",
            }).pipe(
              Effect.andThen(
                publishEvent(
                  makeAssistantMessageUpdatedEvent({
                    id: "assistant-1",
                    sessionId,
                    parentId: messageId,
                  }),
                ),
              ),
              Effect.andThen(Deferred.succeed(assistantFinished, undefined).pipe(Effect.ignore)),
              Effect.andThen(Deferred.await(allowIdleStatus)),
              Effect.andThen(publishEvent(makeSessionIdleEvent(sessionId))),
            )
          : completePrompt({
              messageId: "assistant-2",
              transcript: `final:${prompt}`,
            }),
    });
    const firstMessage = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const secondMessage = makePromptMessage(harness, { id: "message-2", prompt: "follow up" });

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, firstMessage, "hello");
        yield* Deferred.await(assistantFinished);

        expect(yield* Ref.get(harness.replies)).toEqual([]);
        yield* sessions
          .getActiveRunBySessionId("session-1")
          .pipe(
            Effect.flatMap((activeRun) =>
              activeRun ? Effect.void : failTest("active run cleared before idle"),
            ),
          );

        yield* submitPrompt(channels, secondMessage, "follow up");
        expect(yield* Ref.get(harness.replies)).toEqual([]);

        yield* Deferred.succeed(allowIdleStatus, undefined).pipe(Effect.ignore);
        yield* expectReplyEvents(harness.replyEvents, [
          "intermediate",
          `final:${queuedPromptFor(secondMessage, "follow up")}`,
        ]);
      }),
    );

    expect(await getRef(harness.promptCalls)).toEqual([
      promptFor(firstMessage, "hello"),
      queuedPromptFor(secondMessage, "follow up"),
    ]);
    expect(await getRef(harness.replyTargetIds)).toEqual(["message-1", "message-2"]);
  });

  test("ignores replayed message updates from the previous prompt when running an absorbed follow-up", async () => {
    const firstPromptStarted = await makeDeferred();
    const allowFirstPromptToFinish = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({ callIndex, publishEvent, completePrompt, sessionId }) =>
        callIndex === 1
          ? Deferred.succeed(firstPromptStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowFirstPromptToFinish)),
              Effect.andThen(
                completePrompt({
                  messageId: "assistant-1",
                  transcript: "stale-final",
                }),
              ),
            )
          : publishEvent(
              makeAssistantMessageUpdatedEvent({
                id: "assistant-1",
                sessionId,
                parentId: "user-1",
              }),
            ).pipe(
              Effect.andThen(
                publishEvent(
                  makeUserMessageUpdatedEvent({
                    id: "user-1",
                    sessionId,
                  }),
                ),
              ),
              Effect.andThen(
                completePrompt({
                  messageId: "assistant-2",
                  transcript: "follow-up-final",
                }),
              ),
            ),
    });
    const firstMessage = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const secondMessage = makePromptMessage(harness, { id: "message-2", prompt: "follow up" });

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, firstMessage, "hello");
        yield* Deferred.await(firstPromptStarted);
        yield* submitPrompt(channels, secondMessage, "follow up");
        yield* Deferred.succeed(allowFirstPromptToFinish, undefined).pipe(Effect.ignore);
        yield* expectReplyEvents(harness.replyEvents, ["stale-final", "follow-up-final"]);
      }),
    );

    expect(await getRef(harness.replies)).toEqual(["stale-final", "follow-up-final"]);
    expect(await getRef(harness.replyTargetIds)).toEqual(["message-1", "message-2"]);
  });

  test("surfaces compaction summaries as progress updates and still replies with the direct assistant result", async () => {
    const harness = await makeHarness({
      promptImpl: ({ publishEvent, storePromptResult, completePrompt, sessionId }) =>
        storePromptResult({
          messageId: "summary-1",
          transcript: "summary text",
        }).pipe(
          Effect.andThen(
            publishEvent(
              makeAssistantMessageUpdatedEvent({
                id: "summary-1",
                sessionId,
                parentId: "synthetic-1",
                summary: true,
                mode: "compaction",
              }),
            ),
          ),
          Effect.andThen(
            completePrompt({
              messageId: "assistant-1",
              transcript: "final reply",
            }),
          ),
        ),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* expectReplyEvents(harness.replyEvents, [
          "🗜️ Compacted Summary\nsummary text",
          "final reply",
        ]);
      }),
    );

    expect(await getRef(harness.replies)).toEqual(["final reply"]);
  });

  test("surfaces a late compaction summary after the direct reply has already finished", async () => {
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        completePrompt({
          messageId: "assistant-1",
          transcript: "final reply",
        }),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* expectReplyEvents(harness.replyEvents, ["final reply"]);
        yield* waitForNoActiveRun(sessions, "session-1");
        yield* Effect.promise(() =>
          harness.storePromptResult({
            messageId: "summary-1",
            transcript: "summary text",
          }),
        );
        yield* publishHarnessEvent(
          harness,
          makeAssistantMessageUpdatedEvent({
            id: "summary-1",
            parentId: "synthetic-1",
            summary: true,
            mode: "compaction",
          }),
        );
        yield* expectReplyEvents(harness.replyEvents, ["🗜️ Compacted Summary\nsummary text"]);
      }),
    );

    expect(await getRef(harness.replies)).toEqual(["final reply"]);
  });

  test("surfaces a late aborted-tool update in the run UI after the final reply", async () => {
    const harness = await makeHarness({
      promptImpl: ({ publishEvent, storePromptResult, messageId, sessionId }) =>
        storePromptResult({
          messageId: "assistant-1",
          transcript: "done",
        }).pipe(
          Effect.andThen(
            publishEvent(
              makeToolUpdatedEvent({
                sessionId,
                messageId: "assistant-1",
                status: "running",
              }),
            ),
          ),
          Effect.andThen(
            publishEvent(
              makeAssistantMessageUpdatedEvent({
                id: "assistant-1",
                sessionId,
                parentId: messageId,
              }),
            ),
          ),
          Effect.andThen(
            publishEvent(
              makeToolUpdatedEvent({
                sessionId,
                messageId: "assistant-1",
                status: "error",
              }),
            ),
          ),
          Effect.andThen(publishEvent(makeSessionIdleEvent(sessionId))),
        ),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* expectReplyEvents(harness.replyEvents, ["done"]);
      }),
    );

    expect((await getRef(harness.sentPayloads)).map(cardText)).toContain(
      "**💻 🛠️ `bash` Running**\n`pwd`\nPrint cwd",
    );
    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain(
      "**💻 ❌ `bash` Failed in 0.00s**\n`pwd`\nError: `aborted`",
    );
  });

  test("runs /interrupt through ChannelRuntimeLayer and stops the active run", async () => {
    const promptStarted = await makeDeferred();
    const interruptRequested = await makeDeferred();
    const promptFinished = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: () =>
        unsafeEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(promptStarted, undefined);
            yield* Deferred.await(interruptRequested);
            return yield* interruptedTestError("interrupted");
          }).pipe(Effect.ensuring(Deferred.succeed(promptFinished, undefined).pipe(Effect.ignore))),
        ),
      interruptSessionImpl: () =>
        Deferred.succeed(interruptRequested, undefined).pipe(Effect.asVoid),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const command = await harness.makeCommandInteraction("interrupt");

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* Deferred.await(promptStarted);
        yield* channels.handleInteraction(command.interaction);
        yield* Deferred.await(promptFinished);
        yield* waitForNoActiveRun(sessions, "session-1");
      }),
    );

    expect(await getRef(harness.interruptCalls)).toBe(1);
    expect(await getRef(harness.replies)).toEqual([]);
    expect((await getRef(harness.sentPayloads)).map(cardText)).toContain(
      "**‼️ Run interrupted**\nOpenCode stopped the active run in this channel.",
    );
  });

  test("shows the question prompt when it wins the race after /interrupt is requested", async () => {
    const promptStarted = await makeDeferred();
    const interruptRequested = await makeDeferred();
    const allowPromptToFinish = await makeDeferred();
    const promptFinished = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({ publishEvent, completePrompt }) =>
        unsafeEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(promptStarted, undefined);
            yield* Deferred.await(interruptRequested);
            yield* publishEvent(makeQuestionAskedEvent());
            yield* Deferred.await(allowPromptToFinish);
            return yield* completePrompt({
              messageId: "assistant-1",
              transcript: "done",
            });
          }).pipe(Effect.ensuring(Deferred.succeed(promptFinished, undefined).pipe(Effect.ignore))),
        ),
      interruptSessionImpl: () =>
        Deferred.succeed(interruptRequested, undefined).pipe(Effect.asVoid),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const command = await harness.makeCommandInteraction("interrupt");

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* Deferred.await(promptStarted);
        yield* channels.handleInteraction(command.interaction);
        yield* waitForQuestionCard(harness.replyPayloads);
        yield* publishHarnessEvent(harness, makeQuestionRepliedEvent());
        yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore);
        yield* Deferred.await(promptFinished);
        yield* expectReplyEvents(harness.replyEvents, ["done"]);
        yield* nextTick();
      }),
    );

    expect(await getRef(harness.interruptCalls)).toBe(1);
    expect(await getRef(command.interactionDefers)).toBe(1);
    expect(await getRef(command.interactionEdits)).toHaveLength(1);
    expect(
      (await getRef(harness.replyPayloads)).some((payload) =>
        cardText(payload).includes("❓ Questions need answers"),
      ),
    ).toBe(true);
    expect(
      (await getRef(harness.sentPayloads)).some((payload) =>
        cardText(payload).includes("‼️ Run interrupted"),
      ),
    ).toBe(false);
  });

  test("runs /new-session through ChannelRuntimeLayer and recreates the next message on the same workdir", async () => {
    const harness = await makeHarness({
      promptImpl: ({ callIndex, completePrompt }) =>
        completePrompt({
          messageId: `assistant-${callIndex}`,
          transcript: callIndex === 1 ? "first" : "second",
        }),
    });
    const firstMessage = makePromptMessage(harness, { id: "message-1", prompt: "first" });
    const secondMessage = makePromptMessage(harness, { id: "message-2", prompt: "second" });
    const command = await harness.makeCommandInteraction("new-session");

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, firstMessage, "first");
        yield* expectReplyEvents(harness.replyEvents, ["first"]);
        yield* waitForNoActiveRun(sessions, "session-1");

        yield* channels.handleInteraction(command.interaction);
        yield* submitPrompt(channels, secondMessage, "second");
        yield* expectReplyEvents(harness.replyEvents, ["second"]);
      }),
    );

    const createSessionCalls = await getRef(harness.createSessionCalls);
    expect(createSessionCalls).toHaveLength(2);
    expect(createSessionCalls[0]?.workdir).toBe(createSessionCalls[1]?.workdir);
  });

  test("marks idle compaction interrupted when the compaction exits with an abort after interrupt", async () => {
    const compactStarted = await makeDeferred();
    const allowCompactToFinish = await makeDeferred<void, Error>();
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        completePrompt({
          messageId: "assistant-1",
          transcript: "hello",
        }),
      compactSessionImpl: () =>
        Deferred.succeed(compactStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowCompactToFinish)),
        ),
      interruptSessionImpl: () =>
        Deferred.fail(allowCompactToFinish, new Error("aborted")).pipe(Effect.asVoid),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const compactCommand = await harness.makeCommandInteraction("compact");
    const interruptCommand = await harness.makeCommandInteraction("interrupt");

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* Queue.take(harness.replyEvents);
        yield* waitForNoActiveRun(sessions, "session-1");
        yield* channels.handleInteraction(compactCommand.interaction);
        yield* Deferred.await(compactStarted);
        yield* channels.handleInteraction(interruptCommand.interaction);
        yield* nextTick();
      }),
    );

    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain(
      "**‼️ Compaction interrupted**\nOpenCode stopped compacting this session because the run was interrupted.",
    );
  });

  test("does not create an extra compaction completion card when a late completion arrives after an interrupt request", async () => {
    const compactStarted = await makeDeferred();
    const allowCompactToFinish = await makeDeferred();
    const secondPromptStarted = await makeDeferred();
    const allowSecondPromptToFinish = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({ callIndex, completePrompt }) =>
        callIndex === 1
          ? completePrompt({
              messageId: "assistant-1",
              transcript: "hello",
            })
          : Deferred.succeed(secondPromptStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowSecondPromptToFinish)),
              Effect.andThen(
                completePrompt({
                  messageId: "assistant-2",
                  transcript: "later",
                }),
              ),
            ),
      compactSessionImpl: () =>
        Deferred.succeed(compactStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowCompactToFinish)),
        ),
      interruptSessionImpl: () =>
        Deferred.succeed(allowCompactToFinish, undefined).pipe(Effect.asVoid),
    });
    const initialMessage = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const laterMessage = makePromptMessage(harness, { id: "message-2", prompt: "later" });
    const compactCommand = await harness.makeCommandInteraction("compact");
    const interruptCommand = await harness.makeCommandInteraction("interrupt");

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, initialMessage, "hello");
        yield* Queue.take(harness.replyEvents);
        yield* waitForNoActiveRun(sessions, "session-1");

        yield* channels.handleInteraction(compactCommand.interaction);
        yield* Deferred.await(compactStarted);
        yield* channels.handleInteraction(interruptCommand.interaction);

        yield* submitPrompt(channels, laterMessage, "later");
        yield* Deferred.await(secondPromptStarted);
        yield* publishHarnessEvent(harness, makeSessionCompactedEvent());
        yield* Deferred.succeed(allowSecondPromptToFinish, undefined).pipe(Effect.ignore);
        yield* Queue.take(harness.replyEvents);
      }),
    );

    const compactedText =
      "**🗜️ Session compacted**\nOpenCode summarized earlier context for this session.";
    const allCardTexts = [
      ...(await getRef(harness.sentPayloads)).map(cardText),
      ...(await getRef(harness.editedPayloads)).map(cardText),
    ];

    expect(allCardTexts).toContain(
      "**‼️ Interrupting compaction**\nOpenCode is stopping session compaction.",
    );
    expect(allCardTexts.filter((text) => text === compactedText)).toHaveLength(1);
  });

  test("recreates an unhealthy session after a failed run and succeeds on the next submit", async () => {
    const healthy = await runEffect(Ref.make(true));
    const createSessionCount = await runEffect(Ref.make(0));
    const harness = await makeHarness({
      promptImpl: ({ callIndex, completePrompt }) =>
        callIndex === 1
          ? unsafeEffect(
              Effect.gen(function* () {
                yield* Ref.set(healthy, false);
                return yield* failTest("boom");
              }),
            )
          : completePrompt({
              messageId: "assistant-2",
              transcript: "recovered",
            }),
      isHealthyImpl: () => Ref.get(healthy),
      createSessionImpl: ({ callIndex, workdir }) =>
        Ref.update(createSessionCount, (count) => count + 1).pipe(
          Effect.andThen(Ref.set(healthy, true)),
          Effect.as({
            sessionId: `session-${callIndex}`,
            client: {} as never,
            workdir,
            backend: "bwrap",
            close: () => Effect.void,
          } as SessionHandle),
        ),
    });
    const firstMessage = makePromptMessage(harness, { id: "message-1", prompt: "first" });
    const secondMessage = makePromptMessage(harness, { id: "message-2", prompt: "second" });

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, firstMessage, "first");
        expect(yield* Queue.take(harness.replyEvents)).toContain("Opencode failed");
        yield* waitForNoActiveRun(sessions, "session-1");
        yield* submitPrompt(channels, secondMessage, "second");
        yield* expectReplyEvents(harness.replyEvents, ["recovered"]);
      }),
    );

    expect(await getRef(createSessionCount)).toBe(2);
    expect(await getRef(harness.createSessionCalls)).toHaveLength(2);
    expect(await getRef(harness.promptCalls)).toEqual([
      promptFor(firstMessage, "first"),
      promptFor(secondMessage, "second"),
    ]);
  });

  test("processes queued question events through ChannelRuntimeLayer and finalizes the question card", async () => {
    const promptStarted = await makeDeferred();
    const allowPromptToFinish = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowPromptToFinish)),
          Effect.andThen(
            completePrompt({
              messageId: "assistant-1",
              transcript: "question complete",
            }),
          ),
        ),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* Deferred.await(promptStarted);
        yield* publishHarnessEvent(harness, makeQuestionAskedEvent());
        yield* shortDelay();
        yield* publishHarnessEvent(harness, makeQuestionRepliedEvent());
        yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore);
        yield* expectReplyEvents(harness.replyEvents, ["question complete"]);
      }),
    );

    expect((await getRef(harness.replyPayloads)).map(cardText)).toContain(
      "**❓ Questions need answers**\nQuestion 1/1 • 0/1 answered • Pick one • Other allowed • 1 option",
    );
    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain(
      "**✅ Questions answered**\n1 question",
    );
  });

  test("routes question interactions through ChannelRuntimeLayer after command handling falls through", async () => {
    const promptStarted = await makeDeferred();
    const allowPromptToFinish = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowPromptToFinish)),
          Effect.andThen(
            completePrompt({
              messageId: "assistant-1",
              transcript: "done",
            }),
          ),
        ),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const questionInteraction = await harness.makeQuestionButtonInteraction();

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* Deferred.await(promptStarted);
        yield* publishHarnessEvent(harness, makeQuestionAskedEvent());
        yield* shortDelay();
        yield* channels.handleInteraction(questionInteraction.interaction);
        yield* publishHarnessEvent(harness, makeQuestionRepliedEvent());
        yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore);
        yield* Queue.take(harness.replyEvents);
      }),
    );

    expect(await getRef(questionInteraction.interactionReplies)).toEqual([]);
    expect((await getRef(questionInteraction.interactionEdits)).length).toBe(1);
  });

  test("waits for observed session idle before expiring active question cards during session shutdown", async () => {
    const promptStarted = await makeDeferred();
    const interruptStarted = await makeDeferred();
    const allowIdleStatus = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({ messageId, publishEvent, sessionId, storePromptResult }) =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.andThen(
            storePromptResult({
              messageId: "assistant-1",
              transcript: "",
            }),
          ),
          Effect.andThen(
            publishEvent(
              makeAssistantMessageUpdatedEvent({
                id: "assistant-1",
                sessionId,
                parentId: messageId,
              }),
            ),
          ),
          Effect.andThen(Deferred.await(interruptStarted)),
          Effect.andThen(Deferred.await(allowIdleStatus)),
          Effect.andThen(publishEvent(makeSessionIdleEvent(sessionId))),
        ),
      interruptSessionImpl: () => Deferred.succeed(interruptStarted, undefined).pipe(Effect.asVoid),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* Deferred.await(promptStarted);
        yield* publishHarnessEvent(harness, makeQuestionAskedEvent());
        yield* waitForQuestionCard(harness.replyPayloads);

        const shutdownFiber = yield* channels.shutdown().pipe(Effect.forkChild);
        yield* Deferred.await(interruptStarted);
        yield* nextTick();

        const editedPayloads = yield* Ref.get(harness.editedPayloads);
        expect(
          editedPayloads.some((payload) =>
            cardText(payload).includes("This question prompt expired before it was answered."),
          ),
        ).toBe(false);

        yield* Deferred.succeed(allowIdleStatus, undefined).pipe(Effect.ignore);
        yield* Fiber.join(shutdownFiber);
      }),
    );

    expect(
      (await getRef(harness.editedPayloads)).some((payload) =>
        cardText(payload).includes("This question prompt expired before it was answered."),
      ),
    ).toBe(true);
  });

  test("uses shutdown-specific copy for run interrupt cards during graceful shutdown", async () => {
    const promptStarted = await makeDeferred();
    const interruptRequested = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: () =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.andThen(Deferred.await(interruptRequested)),
          Effect.andThen(Effect.fail(interruptedTestError("interrupted"))),
        ),
      interruptSessionImpl: () =>
        Deferred.succeed(interruptRequested, undefined).pipe(Effect.asVoid),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* Deferred.await(promptStarted);
        yield* channels.shutdown();
      }),
    );

    expect((await getRef(harness.sentPayloads)).map(cardText)).toContain(
      "**🛑 Run interrupted**\nOpenCode stopped the active run in this channel because the bot is shutting down.",
    );
  });

  test("ignores new submits and interactions after the channel shutdown gate flips", async () => {
    const harness = await makeHarness({
      promptImpl: () => Effect.void,
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const command = await harness.makeCommandInteraction("compact");

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* channels.shutdown();
        yield* submitPrompt(channels, message, "hello");
        yield* channels.handleInteraction(command.interaction);
        yield* nextTick();
      }),
    );

    expect(await getRef(harness.promptCalls)).toEqual([]);
    expect(await getRef(command.interactionDefers)).toBe(0);
    expect(await getRef(command.interactionReplies)).toEqual([]);
    expect(await getRef(command.interactionEdits)).toEqual([]);
  });

  test("surfaces a question UI failure reply when posting the question card fails", async () => {
    const promptStarted = await makeDeferred();
    const allowPromptToFinish = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowPromptToFinish)),
          Effect.andThen(
            completePrompt({
              messageId: "assistant-1",
              transcript: "",
            }),
          ),
        ),
      failComponentReplies: true,
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* Deferred.await(promptStarted);
        yield* publishHarnessEvent(harness, makeQuestionAskedEvent());
        yield* sessions.getActiveRunBySessionId("session-1").pipe(
          Effect.flatMap((activeRun) =>
            activeRun && activeRun.questionOutcome._tag === "ui-failure"
              ? Effect.void
              : failTest("question UI failure not recorded yet"),
          ),
          Effect.eventually,
          Effect.timeoutOrElse({
            duration: "1 second",
            onTimeout: () =>
              Effect.fail(
                timeoutTestError("Timed out waiting for the current question UI failure state"),
              ),
          }),
        );
        yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore);
        expect(yield* Queue.take(harness.replyEvents)).toContain("Failed to show questions");
      }),
    );

    expect(await getRef(harness.replies)).toHaveLength(1);
    expect(
      (await getRef(harness.replyPayloads)).some((payload) =>
        cardText(payload).includes("❓ Questions need answers"),
      ),
    ).toBe(true);
  });
});
