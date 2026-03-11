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
import { Deferred, Effect, Layer, Queue, Redacted, Ref } from "effect";

import { AppConfig, type AppConfigShape } from "@/config.ts";
import {
  buildOpencodePrompt,
  buildQueuedFollowUpPrompt,
  promptMessageContext,
} from "@/discord/messages.ts";
import type { GlobalEvent } from "@opencode-ai/sdk/v2";
import { type OpencodeEventQueueShape, OpencodeEventQueue } from "@/opencode/events.ts";
import {
  type OpencodeServiceShape,
  OpencodeService,
  type PromptResult,
  type SessionHandle,
} from "@/opencode/service.ts";
import { ChannelSessions, ChannelSessionsLive } from "@/sessions/registry.ts";
import type { PersistedChannelSettings } from "@/state/channel-settings.ts";
import {
  SessionStore,
  type PersistedChannelSession,
  type SessionStoreShape,
} from "@/state/store.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";
import { unsafeEffect, unsafeStub } from "../support/stub.ts";

const TEST_STATE_DIR = join(tmpdir(), `.opencode-discord-test-storage-${process.pid}`);

const makeConfig = (): AppConfigShape => ({
  discordToken: Redacted.make("discord-token"),
  triggerPhrase: "hey opencode",
  sessionInstructions: "",
  stateDir: TEST_STATE_DIR,
  defaultProviderId: undefined,
  defaultModelId: undefined,
  showThinkingByDefault: true,
  showCompactionSummariesByDefault: true,
  sessionIdleTimeoutMs: 30 * 60 * 1_000,
  toolBridgeSocketPath: "/tmp/bridge.sock",
  toolBridgeToken: Redacted.make("bridge-token"),
  sandboxBackend: "bwrap",
  opencodeBin: "opencode",
  bwrapBin: "bwrap",
  sandboxReadOnlyPaths: [],
  sandboxEnvPassthrough: [],
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

const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref));

const waitForNoActiveRun = (
  sessions: { getActiveRunBySessionId: (sessionId: string) => Effect.Effect<unknown> },
  sessionId: string,
) =>
  sessions.getActiveRunBySessionId(sessionId).pipe(
    Effect.flatMap((activeRun) =>
      activeRun ? Effect.fail(new Error("run still active")) : Effect.void,
    ),
    Effect.eventually,
    Effect.timeoutFail({
      duration: "1 second",
      onTimeout: () => new Error(`Timed out waiting for active run ${sessionId} to clear`),
    }),
  );

const cardText = (payload: unknown) =>
  String(
    (payload as { components?: Array<{ components?: Array<{ data?: { content?: string } }> }> })
      .components?.[0]?.components?.[0]?.data?.content ?? "",
  );

const makeQuestionAskedEvent = (): GlobalEvent =>
  unsafeStub<GlobalEvent>({
    payload: {
      type: "question.asked",
      properties: {
        id: "req-1",
        sessionID: "session-1",
        questions: [
          {
            header: "Question",
            question: "Question?",
            options: [{ label: "Yes", description: "desc" }],
          },
        ],
        tool: {
          messageID: "assistant-1",
          callID: "call-1",
        },
      },
    },
  });

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
  });

const makeSessionCompactedEvent = (): GlobalEvent =>
  unsafeStub<GlobalEvent>({
    payload: {
      type: "session.compacted",
      properties: {
        sessionID: "session-1",
      },
    },
  });

const makeAssistantMessageUpdatedEvent = (input: {
  id: string;
  sessionId?: string;
  parentId: string;
  summary?: boolean;
  mode?: string;
}): GlobalEvent =>
  unsafeStub<GlobalEvent>({
    payload: {
      type: "message.updated",
      properties: {
        info: {
          id: input.id,
          sessionID: input.sessionId ?? "session-1",
          role: "assistant",
          parentID: input.parentId,
          mode: input.mode ?? "chat",
          summary: input.summary,
          providerID: "provider-1",
          modelID: "model-1",
          agent: input.summary ? "compaction" : "main",
          path: {
            cwd: "/home/opencode/workspace",
            root: "/home/opencode/workspace",
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
          time: {
            created: 1,
            completed: 2,
          },
        },
      },
    },
  });

const makeUserMessageUpdatedEvent = (input: { id: string; sessionId?: string }): GlobalEvent =>
  unsafeStub<GlobalEvent>({
    payload: {
      type: "message.updated",
      properties: {
        info: {
          id: input.id,
          sessionID: input.sessionId ?? "session-1",
          role: "user",
          agent: "main",
          model: {
            providerID: "provider-1",
            modelID: "model-1",
          },
          time: {
            created: 1,
          },
        },
      },
    },
  });

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
      type: "session.idle",
      properties: {
        sessionID: sessionId,
      },
    },
  });

const makeHarness = async (options: {
  promptImpl: (input: {
    prompt: string;
    callIndex: number;
    messageId: string;
    sessionId: string;
    publishEvent: (event: GlobalEvent) => Effect.Effect<void, never>;
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
  interruptSessionImpl?: () => Effect.Effect<void>;
  rejectQuestionImpl?: () => Effect.Effect<void>;
  failComponentReplies?: boolean;
}) => {
  const replies = await Effect.runPromise(Ref.make<string[]>([]));
  const replyPayloads = await Effect.runPromise(Ref.make<unknown[]>([]));
  const sentPayloads = await Effect.runPromise(Ref.make<unknown[]>([]));
  const editedPayloads = await Effect.runPromise(Ref.make<unknown[]>([]));
  const typing = await Effect.runPromise(Ref.make(0));
  const promptCalls = await Effect.runPromise(Ref.make<string[]>([]));
  const createSessionCalls = await Effect.runPromise(
    Ref.make<Array<{ workdir: string; title: string }>>([]),
  );
  const compactCalls = await Effect.runPromise(Ref.make(0));
  const interruptCalls = await Effect.runPromise(Ref.make(0));
  const createSessionCount = await Effect.runPromise(Ref.make(0));
  const replyEvents = await Effect.runPromise(Queue.unbounded<string>());
  const eventQueue = await Effect.runPromise(Queue.unbounded<GlobalEvent>());
  const promptResults = await Effect.runPromise(Ref.make<Map<string, PromptResult>>(new Map()));
  const persistedSessions = await Effect.runPromise(
    Ref.make<Map<string, PersistedChannelSession>>(new Map()),
  );
  const persistedSettings = await Effect.runPromise(
    Ref.make<Map<string, PersistedChannelSettings>>(new Map()),
  );

  const makePostedMessage = (id: string): Message =>
    unsafeStub<Message>({
      id,
      edit: (payload: MessageEditOptions): Promise<Message> =>
        Effect.runPromise(Ref.update(editedPayloads, (current) => [...current, payload])).then(() =>
          makePostedMessage(id),
        ),
    });

  const sendOnChannel = (payload: MessageCreateOptions) =>
    Effect.runPromise(Ref.update(sentPayloads, (current) => [...current, payload])).then(() => {
      const content = payload.content;
      if (content) {
        return Effect.runPromise(Queue.offer(replyEvents, String(content))).then(() =>
          makePostedMessage(`sent-${Date.now()}`),
        );
      }
      return makePostedMessage(`sent-${Date.now()}`);
    });

  const messageChannel = unsafeStub<SendableChannels>({
    id: "channel-1",
    type: ChannelType.DM,
    isSendable: () => true,
    sendTyping: () => Effect.runPromise(Ref.update(typing, (count) => count + 1)),
    send: sendOnChannel,
  });

  const publishEvent = (event: GlobalEvent) => Queue.offer(eventQueue, event).pipe(Effect.asVoid);

  const storePromptResult = (result: PromptResult) =>
    Ref.update(promptResults, (current) => {
      const next = new Map(current);
      next.set(result.messageId, result);
      return next;
    });

  const completePrompt = (sessionId: string, userMessageId: string, result: PromptResult) =>
    storePromptResult(result).pipe(
      Effect.zipRight(
        publishEvent(
          makeAssistantMessageUpdatedEvent({
            id: result.messageId,
            sessionId,
            parentId: userMessageId,
          }),
        ),
      ),
      Effect.zipRight(publishEvent(makeSessionIdleEvent(sessionId))),
    );

  const commandChannel = unsafeStub<SendableChannels>({
    id: "channel-1",
    type: ChannelType.GuildText,
    isSendable: () => true,
    sendTyping: () => Effect.runPromise(Ref.update(typing, (count) => count + 1)),
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
        Effect.runPromise(Ref.update(replyPayloads, (current) => [...current, payload])).then(
          async () => {
            if (options.failComponentReplies && payload.components?.length) {
              throw new Error("question post failed");
            }
            if (payload.content) {
              await Effect.runPromise(
                Ref.update(replies, (current) => [...current, String(payload.content)]),
              );
              await Effect.runPromise(Queue.offer(replyEvents, String(payload.content)));
            }
            return makePostedMessage(`reply-${input.id}`);
          },
        ),
    });

  const makeCommandInteraction = (
    commandName: "compact" | "interrupt" | "toggle-thinking" | "toggle-compaction-summaries",
  ) => {
    const interactionReplies = Ref.unsafeMake<unknown[]>([]);
    const interactionEdits = Ref.unsafeMake<unknown[]>([]);
    const interactionDefers = Ref.unsafeMake(0);

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
        return Effect.runPromise(
          Ref.update(interactionReplies, (current) => [...current, payload]),
        );
      },
      deferReply: (_payload: unknown) => {
        interaction.deferred = true;
        return Effect.runPromise(Ref.update(interactionDefers, (count) => count + 1));
      },
      editReply: (payload: unknown) =>
        Effect.runPromise(Ref.update(interactionEdits, (current) => [...current, payload])),
    });

    return {
      interaction,
      interactionReplies,
      interactionEdits,
      interactionDefers,
    };
  };

  const makeQuestionButtonInteraction = (input?: { userId?: string; messageId?: string }) => {
    const interactionReplies = Ref.unsafeMake<unknown[]>([]);
    const interactionEdits = Ref.unsafeMake<unknown[]>([]);

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
        return Effect.runPromise(
          Ref.update(interactionReplies, (current) => [...current, payload]),
        );
      },
      update: (payload: unknown) =>
        Effect.runPromise(Ref.update(interactionEdits, (current) => [...current, payload])).then(
          () => makePostedMessage("reply-message-1"),
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
        Effect.zipRight(options.interruptSessionImpl?.() ?? Effect.void),
      ),
    compactSession: () =>
      Ref.update(compactCalls, (count) => count + 1).pipe(
        Effect.zipRight(options.compactSessionImpl?.() ?? Effect.void),
      ),
    replyToQuestion: () => Effect.void,
    rejectQuestion: () => options.rejectQuestionImpl?.() ?? Effect.void,
    isHealthy: () => options.isHealthyImpl?.() ?? Effect.succeed(true),
  };

  const sessionStore: SessionStoreShape = {
    getSession: (channelId) =>
      Ref.get(persistedSessions).pipe(Effect.map((sessions) => sessions.get(channelId) ?? null)),
    upsertSession: (session) =>
      Ref.update(persistedSessions, (sessions) => {
        const next = new Map(sessions);
        next.set(session.channelId, session);
        return next;
      }),
    touchSession: (channelId, lastActivityAt) =>
      Ref.update(persistedSessions, (sessions) => {
        const next = new Map(sessions);
        const current = next.get(channelId);
        if (current) {
          next.set(channelId, {
            ...current,
            lastActivityAt,
          });
        }
        return next;
      }),
    deleteSession: (channelId) =>
      Ref.update(persistedSessions, (sessions) => {
        const next = new Map(sessions);
        next.delete(channelId);
        return next;
      }),
    getChannelSettings: (channelId) =>
      Ref.get(persistedSettings).pipe(Effect.map((settings) => settings.get(channelId) ?? null)),
    upsertChannelSettings: (settings) =>
      Ref.update(persistedSettings, (current) => {
        const next = new Map(current);
        next.set(settings.channelId, settings);
        return next;
      }),
  };

  const deps = Layer.mergeAll(
    Layer.succeed(AppConfig, makeConfig()),
    Layer.succeed(Logger, makeLogger()),
    Layer.succeed(OpencodeService, service),
    Layer.succeed(SessionStore, sessionStore),
    Layer.succeed(OpencodeEventQueue, {
      publish: (event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid),
      take: () => Queue.take(eventQueue),
    } satisfies OpencodeEventQueueShape),
  );
  const layer = Layer.merge(deps, ChannelSessionsLive.pipe(Layer.provide(deps)));

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
    storePromptResult: (result: PromptResult) =>
      Effect.runPromise(storePromptResult(result)).then(() => undefined),
    publishEvent: (event: GlobalEvent) =>
      Effect.runPromise(Queue.offer(eventQueue, event)).then(() => undefined),
  };
};

describe("ChannelSessionsLive integration", () => {
  test("submits a message, prompts opencode, and replies with the final response", async () => {
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        completePrompt({
          messageId: "assistant-1",
          transcript: "done",
        }),
    });
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          expect(yield* Queue.take(harness.replyEvents)).toBe("done");
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(await getRef(harness.promptCalls)).toEqual([
      buildOpencodePrompt({
        message: promptMessageContext(message, "hello"),
      }),
    ]);
    expect(await getRef(harness.replies)).toEqual(["done"]);
    expect(await getRef(harness.createSessionCalls)).toHaveLength(1);
  });

  test("absorbs follow-up messages into the active run and re-prompts opencode", async () => {
    const firstPromptStarted = await Effect.runPromise(Deferred.make<void>());
    const allowFirstPromptToFinish = await Effect.runPromise(Deferred.make<void>());
    const harness = await makeHarness({
      promptImpl: ({ prompt, callIndex, completePrompt }) =>
        callIndex === 1
          ? Deferred.succeed(firstPromptStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(allowFirstPromptToFinish)),
              Effect.zipRight(
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
    const firstMessage = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });
    const secondMessage = harness.makeMessage({
      id: "message-2",
      content: "hey opencode follow up",
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(firstMessage, { prompt: "hello" });
          yield* Deferred.await(firstPromptStarted);
          yield* sessions.submit(secondMessage, { prompt: "follow up" });
          yield* Deferred.succeed(allowFirstPromptToFinish, undefined).pipe(Effect.ignore);
          yield* Queue.take(harness.replyEvents);
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(await getRef(harness.promptCalls)).toEqual([
      buildOpencodePrompt({
        message: promptMessageContext(firstMessage, "hello"),
      }),
      buildQueuedFollowUpPrompt([
        buildOpencodePrompt({
          message: promptMessageContext(secondMessage, "follow up"),
        }),
      ]),
    ]);
    expect(await getRef(harness.replies)).toEqual([
      `final:${buildQueuedFollowUpPrompt([
        buildOpencodePrompt({
          message: promptMessageContext(secondMessage, "follow up"),
        }),
      ])}`,
    ]);
  });

  test("surfaces compaction summaries as progress updates and still replies with the direct assistant result", async () => {
    const harness = await makeHarness({
      promptImpl: ({ publishEvent, storePromptResult, completePrompt, sessionId }) =>
        storePromptResult({
          messageId: "summary-1",
          transcript: "summary text",
        }).pipe(
          Effect.zipRight(
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
          Effect.zipRight(
            completePrompt({
              messageId: "assistant-1",
              transcript: "final reply",
            }),
          ),
        ),
    });
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          expect(yield* Queue.take(harness.replyEvents)).toBe("🗜️ Compacted Summary\nsummary text");
          expect(yield* Queue.take(harness.replyEvents)).toBe("final reply");
        }).pipe(Effect.provide(harness.layer)),
      ),
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
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          expect(yield* Queue.take(harness.replyEvents)).toBe("final reply");
          yield* Effect.promise(() =>
            harness.storePromptResult({
              messageId: "summary-1",
              transcript: "summary text",
            }),
          );
          yield* Effect.promise(() =>
            harness.publishEvent(
              makeAssistantMessageUpdatedEvent({
                id: "summary-1",
                parentId: "synthetic-1",
                summary: true,
                mode: "compaction",
              }),
            ),
          );
          expect(yield* Queue.take(harness.replyEvents)).toBe("🗜️ Compacted Summary\nsummary text");
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(await getRef(harness.replies)).toEqual(["final reply"]);
  });

  test("waits for the late aborted-tool update before finalizing the run UI", async () => {
    const harness = await makeHarness({
      promptImpl: ({ publishEvent, storePromptResult, messageId, sessionId }) =>
        storePromptResult({
          messageId: "assistant-1",
          transcript: "done",
        }).pipe(
          Effect.zipRight(
            publishEvent(
              makeToolUpdatedEvent({
                sessionId,
                messageId: "assistant-1",
                status: "running",
              }),
            ),
          ),
          Effect.zipRight(
            publishEvent(
              makeAssistantMessageUpdatedEvent({
                id: "assistant-1",
                sessionId,
                parentId: messageId,
              }),
            ),
          ),
          Effect.zipRight(
            publishEvent(
              makeToolUpdatedEvent({
                sessionId,
                messageId: "assistant-1",
                status: "error",
              }),
            ),
          ),
          Effect.zipRight(publishEvent(makeSessionIdleEvent(sessionId))),
        ),
    });
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          expect(yield* Queue.take(harness.replyEvents)).toBe("done");
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect((await getRef(harness.sentPayloads)).map(cardText)).toContain(
      "**💻 🛠️ `bash` Running**\n`pwd`\nPrint cwd",
    );
    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain(
      "**💻 ❌ `bash` Failed in 0.00s**\n`pwd`\nError: `aborted`",
    );
  });

  test("runs /compact through the live layer and posts a channel info card", async () => {
    const compactStarted = await Effect.runPromise(Deferred.make<void>());
    const allowCompactToFinish = await Effect.runPromise(Deferred.make<void>());
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        completePrompt({
          messageId: "assistant-1",
          transcript: "done",
        }),
      compactSessionImpl: () =>
        Deferred.succeed(compactStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowCompactToFinish)),
        ),
    });
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });
    const command = harness.makeCommandInteraction("compact");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          yield* Queue.take(harness.replyEvents);
          yield* waitForNoActiveRun(sessions, "session-1");
          yield* sessions.handleInteraction(command.interaction);
          yield* Deferred.await(compactStarted);
          yield* Deferred.succeed(allowCompactToFinish, undefined).pipe(Effect.ignore);
          yield* Effect.promise(() => Bun.sleep(0));
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(await getRef(harness.compactCalls)).toBe(1);
    expect(await getRef(command.interactionDefers)).toBe(1);
    expect(await getRef(command.interactionEdits)).toEqual([
      {
        content: "Started session compaction. I'll post updates in this channel.",
        allowedMentions: { parse: [] },
      },
    ]);
    expect((await getRef(harness.sentPayloads)).map(cardText)).toContain(
      "**🗜️ Compacting session**\nOpenCode is summarizing earlier context for this session.",
    );
    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain(
      "**🗜️ Session compacted**\nOpenCode summarized earlier context for this session.",
    );
  });

  test("runs /interrupt through the live layer and stops the active run", async () => {
    const promptStarted = await Effect.runPromise(Deferred.make<void>());
    const interruptRequested = await Effect.runPromise(Deferred.make<void>());
    const promptFinished = await Effect.runPromise(Deferred.make<void>());
    const harness = await makeHarness({
      promptImpl: () =>
        unsafeEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(promptStarted, undefined);
            yield* Deferred.await(interruptRequested);
            return yield* Effect.fail(new Error("interrupted"));
          }).pipe(Effect.ensuring(Deferred.succeed(promptFinished, undefined).pipe(Effect.ignore))),
        ),
      interruptSessionImpl: () =>
        Deferred.succeed(interruptRequested, undefined).pipe(Effect.asVoid),
    });
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });
    const command = harness.makeCommandInteraction("interrupt");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          yield* Deferred.await(promptStarted);
          yield* sessions.handleInteraction(command.interaction);
          yield* Deferred.await(promptFinished);
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(await getRef(harness.interruptCalls)).toBe(1);
    expect(await getRef(command.interactionDefers)).toBe(1);
    expect(await getRef(command.interactionEdits)).toEqual([
      {
        content: "Interrupted the active OpenCode run.",
        allowedMentions: { parse: [] },
      },
    ]);
    expect(await getRef(harness.replies)).toEqual([]);
    expect((await getRef(harness.sentPayloads)).map(cardText)).toContain(
      "**‼️ Run interrupted**\nOpenCode stopped the active run in this channel.",
    );
  });

  test("runs /interrupt through the live layer, marks compaction interrupting, and allows later completion", async () => {
    const compactStarted = await Effect.runPromise(Deferred.make<void>());
    const allowCompactToFinish = await Effect.runPromise(Deferred.make<void>());
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        completePrompt({
          messageId: "assistant-1",
          transcript: "hello",
        }),
      compactSessionImpl: () =>
        Deferred.succeed(compactStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowCompactToFinish)),
        ),
      interruptSessionImpl: () =>
        Deferred.succeed(allowCompactToFinish, undefined).pipe(Effect.asVoid),
    });
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });
    const compactCommand = harness.makeCommandInteraction("compact");
    const interruptCommand = harness.makeCommandInteraction("interrupt");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          yield* Queue.take(harness.replyEvents);
          yield* waitForNoActiveRun(sessions, "session-1");
          yield* sessions.handleInteraction(compactCommand.interaction);
          yield* Deferred.await(compactStarted);
          yield* sessions.handleInteraction(interruptCommand.interaction);
          yield* Effect.promise(() => Bun.sleep(0));
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(await getRef(harness.interruptCalls)).toBe(1);
    expect(await getRef(interruptCommand.interactionDefers)).toBe(1);
    expect(await getRef(interruptCommand.interactionEdits)).toEqual([
      {
        content: "Requested interruption of the active OpenCode compaction.",
        allowedMentions: { parse: [] },
      },
    ]);
    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain(
      "**‼️ Interrupting compaction**\nOpenCode is stopping session compaction.",
    );
    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain(
      "**🗜️ Session compacted**\nOpenCode summarized earlier context for this session.",
    );
  });

  test("marks idle compaction interrupted when the compaction exits with an abort after interrupt", async () => {
    const compactStarted = await Effect.runPromise(Deferred.make<void>());
    const allowCompactToFinish = await Effect.runPromise(Deferred.make<void, Error>());
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        completePrompt({
          messageId: "assistant-1",
          transcript: "hello",
        }),
      compactSessionImpl: () =>
        Deferred.succeed(compactStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowCompactToFinish)),
        ),
      interruptSessionImpl: () =>
        Deferred.fail(allowCompactToFinish, new Error("aborted")).pipe(Effect.asVoid),
    });
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });
    const compactCommand = harness.makeCommandInteraction("compact");
    const interruptCommand = harness.makeCommandInteraction("interrupt");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          yield* Queue.take(harness.replyEvents);
          yield* waitForNoActiveRun(sessions, "session-1");
          yield* sessions.handleInteraction(compactCommand.interaction);
          yield* Deferred.await(compactStarted);
          yield* sessions.handleInteraction(interruptCommand.interaction);
          yield* Effect.promise(() => Bun.sleep(0));
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain(
      "**‼️ Compaction interrupted**\nOpenCode stopped compacting this session because the run was interrupted.",
    );
  });

  test("does not create an extra compaction completion card when a late completion arrives after an interrupt request", async () => {
    const compactStarted = await Effect.runPromise(Deferred.make<void>());
    const allowCompactToFinish = await Effect.runPromise(Deferred.make<void>());
    const secondPromptStarted = await Effect.runPromise(Deferred.make<void>());
    const allowSecondPromptToFinish = await Effect.runPromise(Deferred.make<void>());
    const harness = await makeHarness({
      promptImpl: ({ callIndex, completePrompt }) =>
        callIndex === 1
          ? completePrompt({
              messageId: "assistant-1",
              transcript: "hello",
            })
          : Deferred.succeed(secondPromptStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(allowSecondPromptToFinish)),
              Effect.zipRight(
                completePrompt({
                  messageId: "assistant-2",
                  transcript: "later",
                }),
              ),
            ),
      compactSessionImpl: () =>
        Deferred.succeed(compactStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowCompactToFinish)),
        ),
      interruptSessionImpl: () =>
        Deferred.succeed(allowCompactToFinish, undefined).pipe(Effect.asVoid),
    });
    const initialMessage = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });
    const laterMessage = harness.makeMessage({
      id: "message-2",
      content: "hey opencode later",
    });
    const compactCommand = harness.makeCommandInteraction("compact");
    const interruptCommand = harness.makeCommandInteraction("interrupt");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(initialMessage, { prompt: "hello" });
          yield* Queue.take(harness.replyEvents);
          yield* waitForNoActiveRun(sessions, "session-1");

          yield* sessions.handleInteraction(compactCommand.interaction);
          yield* Deferred.await(compactStarted);
          yield* sessions.handleInteraction(interruptCommand.interaction);

          yield* sessions.submit(laterMessage, { prompt: "later" });
          yield* Deferred.await(secondPromptStarted);
          yield* Effect.promise(() => harness.publishEvent(makeSessionCompactedEvent()));
          yield* Deferred.succeed(allowSecondPromptToFinish, undefined).pipe(Effect.ignore);
          yield* Queue.take(harness.replyEvents);
        }).pipe(Effect.provide(harness.layer)),
      ),
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
    const healthy = await Effect.runPromise(Ref.make(true));
    const createSessionCount = await Effect.runPromise(Ref.make(0));
    const harness = await makeHarness({
      promptImpl: ({ callIndex, completePrompt }) =>
        callIndex === 1
          ? unsafeEffect(
              Effect.gen(function* () {
                yield* Ref.set(healthy, false);
                return yield* Effect.fail(new Error("boom"));
              }),
            )
          : completePrompt({
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
    });
    const firstMessage = harness.makeMessage({
      id: "message-1",
      content: "hey opencode first",
    });
    const secondMessage = harness.makeMessage({
      id: "message-2",
      content: "hey opencode second",
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(firstMessage, { prompt: "first" });
          expect(yield* Queue.take(harness.replyEvents)).toContain("Opencode failed");
          yield* waitForNoActiveRun(sessions, "session-1");
          yield* sessions.submit(secondMessage, { prompt: "second" });
          expect(yield* Queue.take(harness.replyEvents)).toBe("recovered");
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(await getRef(createSessionCount)).toBe(2);
    expect(await getRef(harness.createSessionCalls)).toHaveLength(2);
    expect(await getRef(harness.promptCalls)).toEqual([
      buildOpencodePrompt({
        message: promptMessageContext(firstMessage, "first"),
      }),
      buildOpencodePrompt({
        message: promptMessageContext(secondMessage, "second"),
      }),
    ]);
  });

  test("processes queued question events through the live layer and finalizes the question card", async () => {
    const promptStarted = await Effect.runPromise(Deferred.make<void>());
    const allowPromptToFinish = await Effect.runPromise(Deferred.make<void>());
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowPromptToFinish)),
          Effect.zipRight(
            completePrompt({
              messageId: "assistant-1",
              transcript: "question complete",
            }),
          ),
        ),
    });
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          yield* Deferred.await(promptStarted);
          yield* Effect.promise(() => harness.publishEvent(makeQuestionAskedEvent()));
          yield* Effect.promise(() => Bun.sleep(10));
          yield* Effect.promise(() => harness.publishEvent(makeQuestionRepliedEvent()));
          yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore);
          expect(yield* Queue.take(harness.replyEvents)).toBe("question complete");
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect((await getRef(harness.replyPayloads)).map(cardText)).toContain(
      "**❓ Questions need answers**\nQuestion 1/1 • 0/1 answered • Pick one • Other allowed • 1 option",
    );
    expect((await getRef(harness.editedPayloads)).map(cardText)).toContain(
      "**✅ Questions answered**\n1 question",
    );
  });

  test("routes question interactions through the live layer after command handling falls through", async () => {
    const promptStarted = await Effect.runPromise(Deferred.make<void>());
    const allowPromptToFinish = await Effect.runPromise(Deferred.make<void>());
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowPromptToFinish)),
          Effect.zipRight(
            completePrompt({
              messageId: "assistant-1",
              transcript: "done",
            }),
          ),
        ),
    });
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });
    const questionInteraction = harness.makeQuestionButtonInteraction();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          yield* Deferred.await(promptStarted);
          yield* Effect.promise(() => harness.publishEvent(makeQuestionAskedEvent()));
          yield* Effect.promise(() => Bun.sleep(10));
          const handled = yield* sessions.handleInteraction(questionInteraction.interaction);
          expect(handled).toBe(true);
          yield* Effect.promise(() => harness.publishEvent(makeQuestionRepliedEvent()));
          yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore);
          yield* Queue.take(harness.replyEvents);
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(await getRef(questionInteraction.interactionReplies)).toEqual([]);
    expect((await getRef(questionInteraction.interactionEdits)).length).toBe(1);
  });

  test("surfaces a question UI failure reply when posting the question card fails", async () => {
    const promptStarted = await Effect.runPromise(Deferred.make<void>());
    const allowPromptToFinish = await Effect.runPromise(Deferred.make<void>());
    const harness = await makeHarness({
      promptImpl: ({ completePrompt }) =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowPromptToFinish)),
          Effect.zipRight(
            completePrompt({
              messageId: "assistant-1",
              transcript: "",
            }),
          ),
        ),
      failComponentReplies: true,
    });
    const message = harness.makeMessage({
      id: "message-1",
      content: "hey opencode hello",
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* ChannelSessions;
          yield* sessions.submit(message, { prompt: "hello" });
          yield* Deferred.await(promptStarted);
          yield* Effect.promise(() => harness.publishEvent(makeQuestionAskedEvent()));
          yield* sessions.getActiveRunBySessionId("session-1").pipe(
            Effect.flatMap((activeRun) =>
              activeRun && activeRun.questionOutcome._tag === "ui-failure"
                ? Effect.void
                : Effect.fail(new Error("question UI failure not recorded yet")),
            ),
            Effect.eventually,
            Effect.timeoutFail({
              duration: "1 second",
              onTimeout: () =>
                new Error("Timed out waiting for the live question UI failure state"),
            }),
          );
          yield* Deferred.succeed(allowPromptToFinish, undefined).pipe(Effect.ignore);
          expect(yield* Queue.take(harness.replyEvents)).toContain("Failed to show questions");
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(await getRef(harness.replies)).toHaveLength(1);
    expect(
      (await getRef(harness.replyPayloads)).some((payload) =>
        cardText(payload).includes("❓ Questions need answers"),
      ),
    ).toBe(true);
  });
});
