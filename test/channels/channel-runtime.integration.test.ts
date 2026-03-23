import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelType,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Queue } from "effect";

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
  cardText,
  makePostedMessage,
  makeRecordedCommandInteraction,
  makeRecordedComponentInteraction,
  makeSendableChannel,
} from "../support/discord.ts";
import {
  makeAssistantMessageUpdatedEvent,
  makeQuestionAskedEvent,
  makeQuestionRepliedEvent,
  makeSessionCompactedEvent,
  makeSessionIdleEvent,
  makeUserMessageUpdatedEvent,
  toGlobalEvent,
} from "../support/opencode-events.ts";
import { makeTestConfig } from "../support/config.ts";
import { failTest, interruptedTestError, timeoutTestError } from "../support/errors.ts";
import { makeDeferred, runTestEffect } from "../support/runtime.ts";
import { unsafeEffect, unsafeStub } from "../support/stub.ts";

const TEST_STATE_DIR = join(tmpdir(), `.opencode-discord-test-storage-${process.pid}`);

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

const promptFor = (message: Message, prompt: string) =>
  buildOpencodePrompt({ message: promptMessageContext(message, prompt) });
const queuedPromptFor = (message: Message, prompt: string) =>
  buildQueuedFollowUpPrompt([promptFor(message, prompt)]);

const waitForNoActiveRun = (
  sessions: { getActiveBySessionId: (sessionId: string) => Effect.Effect<unknown, unknown> },
  sessionId: string,
) =>
  sessions.getActiveBySessionId(sessionId).pipe(
    Effect.flatMap((activeRun) => (activeRun ? failTest("run still active") : Effect.void)),
    Effect.eventually,
    Effect.timeoutOrElse({
      duration: "1 second",
      onTimeout: () =>
        Effect.fail(timeoutTestError(`Timed out waiting for active run ${sessionId} to clear`)),
    }),
  );

const waitForReplyPayload = (replyPayloads: unknown[], predicate: (payload: unknown) => boolean) =>
  Effect.sync(() => replyPayloads.some(predicate)).pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : failTest("payload not posted yet"))),
    Effect.eventually,
    Effect.timeoutOrElse({
      duration: "1 second",
      onTimeout: () => Effect.fail(timeoutTestError("Timed out waiting for reply payload")),
    }),
  );

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

type Harness = Awaited<ReturnType<typeof makeHarness>>;
type RuntimeServices = {
  channels: ChannelRuntimeShape;
  sessions: Pick<SessionRuntimeShape["runs"], "getActiveBySessionId">;
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

const completeWith = (
  completePrompt: (result: PromptResult) => Effect.Effect<void, unknown>,
  messageId: string,
  transcript: string,
) => completePrompt({ messageId, transcript });

const assistantEvent = (
  id: string,
  parentId: string,
  extra: Omit<Parameters<typeof makeAssistantMessageUpdatedEvent>[0], "id" | "parentId"> = {},
) => makeAssistantMessageUpdatedEvent({ id, parentId, ...extra });
const userEvent = (
  id: string,
  extra: Omit<Parameters<typeof makeUserMessageUpdatedEvent>[0], "id"> = {},
) => makeUserMessageUpdatedEvent({ id, ...extra });
const toolUpdatedEvent = (
  status: "running" | "error",
  sessionId: string,
  messageId = "assistant-1",
) => makeToolUpdatedEvent({ sessionId, messageId, status });
const expectCardText = (payloads: unknown[], text: string) =>
  expect(payloads.map(cardText)).toContain(text);
const hasCardText = (payloads: unknown[], text: string) =>
  payloads.some((payload) => cardText(payload).includes(text));

const makeBlockedPromptHarness = async (input: {
  transcript: string;
  failComponentReplies?: boolean;
}) => {
  const promptStarted = await makeDeferred();
  const allowPromptToFinish = await makeDeferred();
  const harness = await makeHarness({
    promptImpl: ({ completePrompt }) =>
      Deferred.succeed(promptStarted, undefined).pipe(
        Effect.andThen(Deferred.await(allowPromptToFinish)),
        Effect.andThen(completeWith(completePrompt, "assistant-1", input.transcript)),
      ),
    failComponentReplies: input.failComponentReplies,
  });

  return {
    harness,
    promptStarted,
    allowPromptToFinish,
    message: makePromptMessage(harness, { id: "message-1", prompt: "hello" }),
  };
};

const waitForQuestionCard = (replyPayloads: unknown[]) =>
  waitForReplyPayload(replyPayloads, (payload) =>
    cardText(payload).includes("❓ Questions need answers"),
  );

const waitForQuestionUiFailure = (sessions: RuntimeServices["sessions"]) =>
  sessions.getActiveBySessionId("session-1").pipe(
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

const nextTick = () => Effect.promise(() => Bun.sleep(0));
const shortDelay = () => Effect.promise(() => Bun.sleep(10));

const withHarness = <A>(
  harness: Harness,
  run: (services: RuntimeServices) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
) =>
  runTestEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const channels = yield* ChannelRuntime;
        const sessions = (yield* SessionRuntime).runs;
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
  const replies: string[] = [];
  const replyTargetIds: string[] = [];
  const sentPayloads: unknown[] = [];
  let typing = 0;
  const promptCalls: string[] = [];
  const createSessionCalls: Array<{ workdir: string; title: string }> = [];
  let compactCalls = 0;
  let interruptCalls = 0;
  let createSessionCount = 0;
  const [replyEvents, eventQueue] = await runTestEffect(
    Effect.all([Queue.unbounded<string>(), Queue.unbounded<GlobalEvent>()]),
  );
  const replyPayloads: unknown[] = [];
  const editedPayloads: unknown[] = [];
  const promptResults = new Map<string, PromptResult>();
  const persistedSessions = new Map<string, PersistedChannelSession>();
  const persistedSettings = new Map<string, PersistedChannelSettings>();

  const nextPostedMessage = (id: string): Message =>
    makePostedMessage(id, async (payload: MessageEditOptions) => {
      editedPayloads.push(payload);
      return nextPostedMessage(id);
    });

  const sendOnChannel = (payload: MessageCreateOptions) =>
    Promise.resolve().then(() => {
      sentPayloads.push(payload);
      if (options.failChannelSend) {
        throw new Error("channel send failed");
      }
      const content = payload.content;
      if (content) {
        return runTestEffect(Queue.offer(replyEvents, String(content))).then(() =>
          nextPostedMessage(`sent-${Date.now()}`),
        );
      }
      return nextPostedMessage(`sent-${Date.now()}`);
    });

  const messageChannel = makeSendableChannel({
    id: "channel-1",
    type: ChannelType.DM,
    sendTyping: async () => {
      typing += 1;
    },
    send: sendOnChannel,
  });

  const publishEvent = (event: Event | GlobalEvent) =>
    Queue.offer(eventQueue, "payload" in event ? event : toGlobalEvent(event)).pipe(Effect.asVoid);

  const storePromptResult = (result: PromptResult) =>
    Effect.sync(() => {
      promptResults.set(result.messageId, result);
    });

  const completePrompt = (sessionId: string, userMessageId: string, result: PromptResult) =>
    storePromptResult(result).pipe(
      Effect.andThen(publishEvent(assistantEvent(result.messageId, userMessageId, { sessionId }))),
      Effect.andThen(publishEvent(makeSessionIdleEvent(sessionId))),
    );

  const commandChannel = makeSendableChannel({
    id: "channel-1",
    type: ChannelType.GuildText,
    sendTyping: async () => {
      typing += 1;
    },
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
        Promise.resolve()
          .then(() => {
            replyTargetIds.push(input.id);
          })
          .then(() =>
            Promise.resolve(replyPayloads.push(payload)).then(async () => {
              if (options.failComponentReplies && payload.components?.length) {
                throw new Error("question post failed");
              }
              if (payload.content) {
                replies.push(String(payload.content));
                await runTestEffect(Queue.offer(replyEvents, String(payload.content)));
              }
              return nextPostedMessage(`reply-${input.id}`);
            }),
          ),
    });

  const makeCommandInteraction = (
    commandName:
      | "compact"
      | "interrupt"
      | "new-session"
      | "toggle-thinking"
      | "toggle-compaction-summaries",
  ) => {
    const interactionReplies: unknown[] = [];
    const interactionEdits: unknown[] = [];

    const { interaction, readDefers } = makeRecordedCommandInteraction({
      commandName,
      channel: commandChannel,
      onReply: (payload) => {
        interactionReplies.push(payload);
        return Promise.resolve();
      },
      onDeferReply: () => Promise.resolve(),
      onEditReply: (payload) => {
        interactionEdits.push(payload);
        return Promise.resolve();
      },
    });

    return {
      interaction,
      interactionReplies,
      interactionEdits,
      readInteractionDefers: readDefers,
    };
  };

  const makeQuestionButtonInteraction = (input?: { userId?: string; messageId?: string }) => {
    const interactionReplies: unknown[] = [];
    const interactionEdits: unknown[] = [];

    const interaction = makeRecordedComponentInteraction("button", {
      customId: "ocq:session-1:req-1:0:submit",
      userId: input?.userId ?? "intruder",
      messageId: input?.messageId ?? "reply-message-1",
      onReply: (payload) => {
        interactionReplies.push(payload);
        return Promise.resolve();
      },
      onUpdate: (payload) => {
        interactionEdits.push(payload);
        return Promise.resolve();
      },
      update: () => Promise.resolve(nextPostedMessage("reply-message-1")),
      followUp: () => Promise.resolve(nextPostedMessage("reply-message-1")),
    });

    return {
      interaction,
      interactionReplies,
      interactionEdits,
    };
  };

  const service: OpencodeServiceShape = {
    createSession: (workdir, title) =>
      Effect.sync(() => {
        createSessionCount += 1;
        createSessionCalls.push({ workdir, title });
        return createSessionCount;
      }).pipe(
        Effect.flatMap(
          (callIndex) =>
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
    attachSession: (workdir, sessionId) =>
      Effect.succeed({
        sessionId,
        client: {} as never,
        workdir,
        backend: "bwrap",
        close: () => Effect.void,
      } as SessionHandle),
    submitPrompt: (_session, prompt) =>
      Effect.sync(() => {
        promptCalls.push(prompt);
        return promptCalls.length;
      }).pipe(
        Effect.flatMap((callIndex) =>
          Effect.gen(function* () {
            const messageId = `user-${callIndex}`;
            yield* publishEvent(userEvent(messageId, { sessionId: _session.sessionId }));
            yield* options.promptImpl({
              prompt,
              callIndex,
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
      Effect.sync(() => {
        const result = promptResults.get(messageId);
        if (!result) {
          throw new Error(`missing prompt result ${messageId}`);
        }
        return result;
      }),
    interruptSession: () =>
      Effect.sync(() => {
        interruptCalls += 1;
      }).pipe(Effect.andThen(options.interruptSessionImpl?.() ?? Effect.void)),
    compactSession: () =>
      Effect.sync(() => {
        compactCalls += 1;
      }).pipe(Effect.andThen(options.compactSessionImpl?.() ?? Effect.void)),
    replyToQuestion: () => Effect.void,
    rejectQuestion: () => options.rejectQuestionImpl?.() ?? Effect.void,
    isHealthy: () => options.isHealthyImpl?.() ?? Effect.succeed(true),
  };

  const statePersistence: StatePersistenceShape = {
    getSession: (channelId) => Effect.succeed(persistedSessions.get(channelId) ?? null),
    upsertSession: (session) =>
      Effect.sync(() => {
        persistedSessions.set(session.channelId, session);
      }),
    touchSession: (channelId, lastActivityAt) =>
      Effect.sync(() => {
        const session = persistedSessions.get(channelId);
        if (session) {
          persistedSessions.set(channelId, {
            ...session,
            lastActivityAt,
          });
        }
      }),
    deleteSession: (channelId) =>
      Effect.sync(() => {
        persistedSessions.delete(channelId);
      }),
    getChannelSettings: (channelId) => Effect.succeed(persistedSettings.get(channelId) ?? null),
    upsertChannelSettings: (settings) =>
      Effect.sync(() => {
        persistedSettings.set(settings.channelId, settings);
      }),
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
    readTyping: () => typing,
    promptCalls,
    createSessionCalls,
    readCompactCalls: () => compactCalls,
    readInterruptCalls: () => interruptCalls,
    harnessLayer,
    makeMessage,
    makeCommandInteraction,
    makeQuestionButtonInteraction,
    storePromptResult: (result: PromptResult) =>
      runTestEffect(storePromptResult(result)).then(() => undefined),
    publishEvent: (event: Event | GlobalEvent) =>
      runTestEffect(publishEvent(event)).then(() => undefined),
  };
};

describe("ChannelRuntimeLayer integration", () => {
  test("submits a message, prompts opencode, and replies with the final response", async () => {
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) => completeWith(completePrompt, "assistant-1", "done"),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* expectReplyEvents(harness.replyEvents, ["done"]);
      }),
    );

    expect(harness.promptCalls).toEqual([promptFor(message, "hello")]);
    expect(harness.replies).toEqual(["done"]);
    expect(harness.createSessionCalls).toHaveLength(1);
  });

  test("absorbs follow-up messages into the active run and re-prompts opencode", async () => {
    const firstPromptStarted = await makeDeferred();
    const allowFirstPromptToFinish = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({ prompt, callIndex, completePrompt }) =>
        callIndex === 1
          ? Deferred.succeed(firstPromptStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowFirstPromptToFinish)),
              Effect.andThen(completeWith(completePrompt, "assistant-1", "intermediate")),
            )
          : completeWith(completePrompt, "assistant-2", `final:${prompt}`),
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

    expect(harness.promptCalls).toEqual([
      promptFor(firstMessage, "hello"),
      queuedPromptFor(secondMessage, "follow up"),
    ]);
    expect(harness.replies).toEqual([
      "intermediate",
      `final:${queuedPromptFor(secondMessage, "follow up")}`,
    ]);
    expect(harness.replyTargetIds).toEqual(["message-1", "message-2"]);
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
              Effect.andThen(publishEvent(assistantEvent("assistant-1", messageId, { sessionId }))),
              Effect.andThen(Deferred.succeed(assistantFinished, undefined).pipe(Effect.ignore)),
              Effect.andThen(Deferred.await(allowIdleStatus)),
              Effect.andThen(publishEvent(makeSessionIdleEvent(sessionId))),
            )
          : completeWith(completePrompt, "assistant-2", `final:${prompt}`),
    });
    const firstMessage = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const secondMessage = makePromptMessage(harness, { id: "message-2", prompt: "follow up" });

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, firstMessage, "hello");
        yield* Deferred.await(assistantFinished);

        expect(harness.replies).toEqual([]);
        yield* sessions
          .getActiveBySessionId("session-1")
          .pipe(
            Effect.flatMap((activeRun) =>
              activeRun ? Effect.void : failTest("active run cleared before idle"),
            ),
          );

        yield* submitPrompt(channels, secondMessage, "follow up");
        expect(harness.replies).toEqual([]);

        yield* Deferred.succeed(allowIdleStatus, undefined).pipe(Effect.ignore);
        yield* expectReplyEvents(harness.replyEvents, [
          "intermediate",
          `final:${queuedPromptFor(secondMessage, "follow up")}`,
        ]);
      }),
    );

    expect(harness.promptCalls).toEqual([
      promptFor(firstMessage, "hello"),
      queuedPromptFor(secondMessage, "follow up"),
    ]);
    expect(harness.replyTargetIds).toEqual(["message-1", "message-2"]);
  });

  test("ignores replayed message updates from the previous prompt when running an absorbed follow-up", async () => {
    const firstPromptStarted = await makeDeferred();
    const allowFirstPromptToFinish = await makeDeferred();
    const harness = await makeHarness({
      promptImpl: ({ callIndex, publishEvent, completePrompt, sessionId }) =>
        callIndex === 1
          ? Deferred.succeed(firstPromptStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowFirstPromptToFinish)),
              Effect.andThen(completeWith(completePrompt, "assistant-1", "stale-final")),
            )
          : publishEvent(assistantEvent("assistant-1", "user-1", { sessionId })).pipe(
              Effect.andThen(publishEvent(userEvent("user-1", { sessionId }))),
              Effect.andThen(completeWith(completePrompt, "assistant-2", "follow-up-final")),
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

    expect(harness.replies).toEqual(["stale-final", "follow-up-final"]);
    expect(harness.replyTargetIds).toEqual(["message-1", "message-2"]);
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
              assistantEvent("summary-1", "synthetic-1", {
                sessionId,
                summary: true,
                mode: "compaction",
              }),
            ),
          ),
          Effect.andThen(completeWith(completePrompt, "assistant-1", "final reply")),
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

    expect(harness.replies).toEqual(["final reply"]);
  });

  test("surfaces a late compaction summary after the direct reply has already finished", async () => {
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        completeWith(completePrompt, "assistant-1", "final reply"),
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
          assistantEvent("summary-1", "synthetic-1", {
            summary: true,
            mode: "compaction",
          }),
        );
        yield* expectReplyEvents(harness.replyEvents, ["🗜️ Compacted Summary\nsummary text"]);
      }),
    );

    expect(harness.replies).toEqual(["final reply"]);
  });

  test("surfaces a late aborted-tool update in the run UI after the final reply", async () => {
    const harness = await makeHarness({
      promptImpl: ({ publishEvent, storePromptResult, messageId, sessionId }) =>
        storePromptResult({
          messageId: "assistant-1",
          transcript: "done",
        }).pipe(
          Effect.andThen(publishEvent(toolUpdatedEvent("running", sessionId))),
          Effect.andThen(publishEvent(assistantEvent("assistant-1", messageId, { sessionId }))),
          Effect.andThen(publishEvent(toolUpdatedEvent("error", sessionId))),
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

    expectCardText(harness.sentPayloads, "**💻 🛠️ `bash` Running**\n`pwd`\nPrint cwd");
    expectCardText(
      harness.editedPayloads,
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
    const command = harness.makeCommandInteraction("interrupt");

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* Deferred.await(promptStarted);
        yield* channels.handleInteraction(command.interaction);
        yield* Deferred.await(promptFinished);
        yield* waitForNoActiveRun(sessions, "session-1");
      }),
    );

    expect(harness.readInterruptCalls()).toBe(1);
    expect(harness.replies).toEqual([]);
    expectCardText(
      harness.sentPayloads,
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
            return yield* completeWith(completePrompt, "assistant-1", "done");
          }).pipe(Effect.ensuring(Deferred.succeed(promptFinished, undefined).pipe(Effect.ignore))),
        ),
      interruptSessionImpl: () =>
        Deferred.succeed(interruptRequested, undefined).pipe(Effect.asVoid),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const command = harness.makeCommandInteraction("interrupt");

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

    expect(harness.readInterruptCalls()).toBe(1);
    expect(command.readInteractionDefers()).toBe(1);
    expect(command.interactionEdits).toHaveLength(1);
    expect(hasCardText(harness.replyPayloads, "❓ Questions need answers")).toBe(true);
    expect(hasCardText(harness.sentPayloads, "‼️ Run interrupted")).toBe(false);
  });

  test("runs /new-session through ChannelRuntimeLayer and recreates the next message on the same workdir", async () => {
    const harness = await makeHarness({
      promptImpl: ({ callIndex, completePrompt }) =>
        completeWith(
          completePrompt,
          `assistant-${callIndex}`,
          callIndex === 1 ? "first" : "second",
        ),
    });
    const firstMessage = makePromptMessage(harness, { id: "message-1", prompt: "first" });
    const secondMessage = makePromptMessage(harness, { id: "message-2", prompt: "second" });
    const command = harness.makeCommandInteraction("new-session");

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

    expect(harness.createSessionCalls).toHaveLength(2);
    expect(harness.createSessionCalls[0]?.workdir).toBe(harness.createSessionCalls[1]?.workdir);
  });

  test("marks idle compaction interrupted when the compaction exits with an abort after interrupt", async () => {
    const compactStarted = await makeDeferred();
    const allowCompactToFinish = await makeDeferred<void, Error>();
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) => completeWith(completePrompt, "assistant-1", "hello"),
      compactSessionImpl: () =>
        Deferred.succeed(compactStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowCompactToFinish)),
        ),
      interruptSessionImpl: () =>
        Deferred.fail(allowCompactToFinish, new Error("aborted")).pipe(Effect.asVoid),
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const compactCommand = harness.makeCommandInteraction("compact");
    const interruptCommand = harness.makeCommandInteraction("interrupt");

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

    expectCardText(
      harness.editedPayloads,
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
          ? completeWith(completePrompt, "assistant-1", "hello")
          : Deferred.succeed(secondPromptStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowSecondPromptToFinish)),
              Effect.andThen(completeWith(completePrompt, "assistant-2", "later")),
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
    const compactCommand = harness.makeCommandInteraction("compact");
    const interruptCommand = harness.makeCommandInteraction("interrupt");

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
      ...harness.sentPayloads.map(cardText),
      ...harness.editedPayloads.map(cardText),
    ];

    expect(allCardTexts).toContain(
      "**‼️ Interrupting compaction**\nOpenCode is stopping session compaction.",
    );
    expect(allCardTexts.filter((text) => text === compactedText)).toHaveLength(1);
  });

  test("recreates an unhealthy session after a failed run and succeeds on the next submit", async () => {
    let healthy = true;
    let createSessionCount = 0;
    const harness = await makeHarness({
      promptImpl: ({ callIndex, completePrompt }) =>
        callIndex === 1
          ? unsafeEffect(
              Effect.gen(function* () {
                healthy = false;
                return yield* failTest("boom");
              }),
            )
          : completeWith(completePrompt, "assistant-2", "recovered"),
      isHealthyImpl: () => Effect.succeed(healthy),
      createSessionImpl: ({ callIndex, workdir }) =>
        Effect.sync(() => {
          createSessionCount += 1;
          healthy = true;
        }).pipe(
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

    expect(createSessionCount).toBe(2);
    expect(harness.createSessionCalls).toHaveLength(2);
    expect(harness.promptCalls).toEqual([
      promptFor(firstMessage, "first"),
      promptFor(secondMessage, "second"),
    ]);
  });

  test("processes queued question events through ChannelRuntimeLayer and finalizes the question card", async () => {
    const { harness, promptStarted, allowPromptToFinish, message } = await makeBlockedPromptHarness(
      {
        transcript: "question complete",
      },
    );

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

    expectCardText(
      harness.replyPayloads,
      "**❓ Questions need answers**\nQuestion 1/1 • 0/1 answered • Pick one • Other allowed • 1 option",
    );
    expectCardText(harness.editedPayloads, "**✅ Questions answered**\n1 question");
  });

  test("routes question interactions through ChannelRuntimeLayer after command handling falls through", async () => {
    const { harness, promptStarted, allowPromptToFinish, message } = await makeBlockedPromptHarness(
      {
        transcript: "done",
      },
    );
    const questionInteraction = harness.makeQuestionButtonInteraction();

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

    expect(questionInteraction.interactionReplies).toEqual([]);
    expect(questionInteraction.interactionEdits.length).toBe(1);
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
          Effect.andThen(publishEvent(assistantEvent("assistant-1", messageId, { sessionId }))),
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

        expect(
          hasCardText(
            harness.editedPayloads,
            "This question prompt expired before it was answered.",
          ),
        ).toBe(false);

        yield* Deferred.succeed(allowIdleStatus, undefined).pipe(Effect.ignore);
        yield* Fiber.join(shutdownFiber);
      }),
    );

    expect(
      hasCardText(harness.editedPayloads, "This question prompt expired before it was answered."),
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

    expectCardText(
      harness.sentPayloads,
      "**🛑 Run interrupted**\nOpenCode stopped the active run in this channel because the bot is shutting down.",
    );
  });

  test("ignores new submits and interactions after the channel shutdown gate flips", async () => {
    const harness = await makeHarness({
      promptImpl: () => Effect.void,
    });
    const message = makePromptMessage(harness, { id: "message-1", prompt: "hello" });
    const command = harness.makeCommandInteraction("compact");

    await withHarness(harness, ({ channels }) =>
      Effect.gen(function* () {
        yield* channels.shutdown();
        yield* submitPrompt(channels, message, "hello");
        yield* channels.handleInteraction(command.interaction);
        yield* nextTick();
      }),
    );

    expect(harness.promptCalls).toEqual([]);
    expect(command.readInteractionDefers()).toBe(0);
    expect(command.interactionReplies).toEqual([]);
    expect(command.interactionEdits).toEqual([]);
  });

  test("surfaces a question UI failure reply when posting the question card fails", async () => {
    const { harness, promptStarted, allowPromptToFinish, message } = await makeBlockedPromptHarness(
      {
        transcript: "",
        failComponentReplies: true,
      },
    );

    await withHarness(harness, ({ channels, sessions }) =>
      Effect.gen(function* () {
        yield* submitPrompt(channels, message, "hello");
        yield* Deferred.await(promptStarted);
        yield* publishHarnessEvent(harness, makeQuestionAskedEvent());
        yield* waitForQuestionUiFailure(sessions);
        yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore);
        expect(yield* Queue.take(harness.replyEvents)).toContain("Failed to show questions");
      }),
    );

    expect(harness.replies).toHaveLength(1);
    expect(hasCardText(harness.replyPayloads, "❓ Questions need answers")).toBe(true);
  });
});
