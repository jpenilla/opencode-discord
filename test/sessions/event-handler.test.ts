import { describe, expect, test } from "bun:test";
import type {
  Event,
  QuestionAnswer,
  QuestionRequest,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Option, Queue, Ref } from "effect";
import type { Message } from "discord.js";

import type { SessionHandle } from "@/opencode/service.ts";
import { createEventHandler } from "@/sessions/event-handler.ts";
import { beginPendingPrompt, createPromptState } from "@/sessions/run/prompt-state.ts";
import {
  noQuestionOutcome,
  type ActiveRun,
  type ChannelSession,
  type RunProgressEvent,
} from "@/sessions/session.ts";
import { unsafeStub } from "../support/stub.ts";

const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref));

const makeSession = async (withActiveRun: boolean, showCompactionSummaries = true) => {
  const progressQueue = await Effect.runPromise(Queue.unbounded<RunProgressEvent>());
  const promptState = await Effect.runPromise(createPromptState());
  const activeRun = withActiveRun
    ? unsafeStub<ActiveRun>({
        originMessage: unsafeStub<Message>({
          id: "discord-message",
          channelId: "channel-1",
          channel: { id: "channel-1" },
          attachments: new Map(),
        }),
        workdir: "/home/opencode/workspace",
        attachmentMessagesById: new Map(),
        currentPromptContext: null,
        previousPromptMessageIds: new Set<string>(),
        currentPromptMessageIds: new Set<string>(),
        currentPromptUserMessageId: null,
        assistantMessageParentIds: new Map<string, string>(),
        observedToolCallIds: new Set<string>(),
        progressQueue,
        promptState,
        followUpQueue: {} as ActiveRun["followUpQueue"],
        acceptFollowUps: {} as ActiveRun["acceptFollowUps"],
        typing: {
          pause: () => Promise.resolve(),
          resume: () => {},
          stop: () => Promise.resolve(),
        },
        questionOutcome: noQuestionOutcome(),
        interruptRequested: false,
        interruptSource: null,
      })
    : null;

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
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    channelSettings: {
      showThinking: true,
      showCompactionSummaries,
    },
    progressChannel: null,
    progressMentionContext: null,
    emittedCompactionSummaryMessageIds: new Set<string>(),
    queue: {} as ChannelSession["queue"],
    activeRun,
  });

  return { session, activeRun, progressQueue, promptState };
};

const makeQuestionAskedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "question.asked",
    properties: {
      id: "req-1",
      sessionID: sessionId,
      questions: [
        {
          header: "Question",
          question: "Question?",
          options: [{ label: "Yes", description: "desc" }],
        },
      ],
      tool: {
        messageID: "message-1",
        callID: "call-1",
      },
    } satisfies QuestionRequest,
  });

const makeQuestionRepliedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "question.replied",
    properties: {
      sessionID: sessionId,
      requestID: "req-1",
      answers: [["Yes"]] satisfies ReadonlyArray<QuestionAnswer>,
    },
  });

const makeQuestionRejectedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "question.rejected",
    properties: {
      sessionID: sessionId,
      requestID: "req-1",
    },
  });

const makeSessionStatusEvent = (sessionId = "session-1", status: "busy" | "idle" = "busy"): Event =>
  unsafeStub<Event>({
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: {
        type: status,
      },
    },
  });

const makeSessionCompactedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "session.compacted",
    properties: {
      sessionID: sessionId,
    },
  });

const makeAssistantMessageUpdatedEvent = (input: {
  id: string;
  parentId: string;
  summary?: boolean;
  mode?: string;
  completed?: boolean;
  error?: { name: "MessageAbortedError"; data: { message: string } };
}): Event =>
  unsafeStub<Event>({
    type: "message.updated",
    properties: {
      info: {
        id: input.id,
        sessionID: "session-1",
        role: "assistant",
        parentID: input.parentId,
        mode: input.mode ?? "chat",
        summary: input.summary,
        error: input.error,
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
        time: input.completed
          ? {
              created: 1,
              completed: 2,
            }
          : {
              created: 1,
            },
      },
    },
  });

const makeUserMessageUpdatedEvent = (id = "user-1"): Event =>
  unsafeStub<Event>({
    type: "message.updated",
    properties: {
      info: {
        id,
        sessionID: "session-1",
        role: "user",
        agent: "main",
        model: {
          providerID: "provider-1",
          modelID: "model-1",
        },
        time: {
          created: 1,
        },
      } satisfies UserMessage,
    },
  });

const makeToolPart = (
  status: "running" | "completed" | "error",
  input?: {
    messageId?: string;
    callId?: string;
  },
): ToolPart =>
  unsafeStub<ToolPart>({
    id: `part-${status}`,
    sessionID: "session-1",
    messageID: input?.messageId ?? "assistant-1",
    type: "tool",
    callID: input?.callId ?? "call-1",
    tool: "bash",
    state:
      status === "running"
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
        : status === "completed"
          ? {
              status: "completed",
              input: {
                command: "pwd",
              },
              title: "Print cwd",
              time: {
                start: 1,
                end: 2,
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
  });

const makeToolEvent = (
  status: "running" | "completed" | "error",
  input?: {
    messageId?: string;
    callId?: string;
  },
): Event =>
  unsafeStub<Event>({
    type: "message.part.updated",
    properties: {
      part: makeToolPart(status, input),
    },
  });

const noopIdleCompactionWorkflow = {
  emitSummary: () => Effect.void,
  handleCompacted: () => Effect.void,
};

describe("createEventHandler", () => {
  test("routes question asked events to the question coordinator", async () => {
    const { session } = await makeSession(false);
    const questionEvents = await Effect.runPromise(Ref.make<unknown[]>([]));

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(
          sessionId === session.opencode.sessionId ? { session, activeRun: null } : null,
        ),
      handleQuestionEvent: (event) => Ref.update(questionEvents, (current) => [...current, event]),
      idleCompactionWorkflow: noopIdleCompactionWorkflow,
      readPromptResult: () => Effect.fail(new Error("unexpected prompt result load")),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(runtime.handleEvent(makeQuestionAskedEvent()));

    expect(await getRef(questionEvents)).toEqual([
      {
        type: "asked",
        sessionId: "session-1",
        request: makeQuestionAskedEvent().properties,
      },
    ]);
  });

  test("routes question reply and rejection events to the question coordinator", async () => {
    const { session } = await makeSession(false);
    const questionEvents = await Effect.runPromise(Ref.make<unknown[]>([]));

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(
          sessionId === session.opencode.sessionId ? { session, activeRun: null } : null,
        ),
      handleQuestionEvent: (event) => Ref.update(questionEvents, (current) => [...current, event]),
      idleCompactionWorkflow: noopIdleCompactionWorkflow,
      readPromptResult: () => Effect.fail(new Error("unexpected prompt result load")),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(runtime.handleEvent(makeQuestionRepliedEvent()));
    await Effect.runPromise(runtime.handleEvent(makeQuestionRejectedEvent()));

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
    ]);
  });

  test("enqueues progress events for active runs", async () => {
    const { session, activeRun, progressQueue } = await makeSession(true);

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: noopIdleCompactionWorkflow,
      readPromptResult: () => Effect.fail(new Error("unexpected prompt result load")),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(runtime.handleEvent(makeSessionStatusEvent()));

    expect(await Effect.runPromise(Queue.takeAll(progressQueue))).toEqual([
      {
        type: "session-status",
        status: { type: "busy" },
      },
    ]);
  });

  test("updates the idle compaction card when compaction finishes outside an active run", async () => {
    const { session } = await makeSession(false);
    const idleUpdates = await Effect.runPromise(Ref.make<string[]>([]));

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(
          sessionId === session.opencode.sessionId ? { session, activeRun: null } : null,
        ),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: {
        ...noopIdleCompactionWorkflow,
        handleCompacted: (sessionId) =>
          Ref.update(idleUpdates, (current) => [...current, sessionId]),
      },
      readPromptResult: () => Effect.fail(new Error("unexpected prompt result load")),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(runtime.handleEvent(makeSessionCompactedEvent()));

    expect(await getRef(idleUpdates)).toEqual(["session-1"]);
  });

  test("ignores events for sessions that are not currently tracked", async () => {
    const questionEvents = await Effect.runPromise(Ref.make(0));
    const idleUpdates = await Effect.runPromise(Ref.make(0));

    const runtime = createEventHandler({
      getSessionContext: () => Effect.succeed(null),
      handleQuestionEvent: () => Ref.update(questionEvents, (count) => count + 1),
      idleCompactionWorkflow: {
        ...noopIdleCompactionWorkflow,
        handleCompacted: () => Ref.update(idleUpdates, (count) => count + 1),
      },
      readPromptResult: () => Effect.fail(new Error("unexpected prompt result load")),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(runtime.handleEvent(makeQuestionAskedEvent("missing-session")));
    await Effect.runPromise(runtime.handleEvent(makeSessionCompactedEvent("missing-session")));

    expect(await getRef(questionEvents)).toBe(0);
    expect(await getRef(idleUpdates)).toBe(0);
  });

  test("emits a late compaction summary once even after the active run is gone", async () => {
    const { session } = await makeSession(false);
    const readPromptCalls = await Effect.runPromise(Ref.make<string[]>([]));
    const sentSummaries = await Effect.runPromise(Ref.make<string[]>([]));

    const readPromptResult = (_session: SessionHandle, messageId: string) =>
      Ref.update(readPromptCalls, (current) => [...current, messageId]).pipe(
        Effect.as({
          messageId,
          transcript: "summary text",
        }),
      );
    const sendCompactionSummary = (_session: ChannelSession, text: string) =>
      Ref.update(sentSummaries, (current) => [...current, text]).pipe(Effect.asVoid);

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(
          sessionId === session.opencode.sessionId ? { session, activeRun: null } : null,
        ),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: {
        ...noopIdleCompactionWorkflow,
        emitSummary: ({ session, messageId }) =>
          Effect.sync(() => {
            if (session.emittedCompactionSummaryMessageIds.has(messageId)) {
              return false;
            }
            session.emittedCompactionSummaryMessageIds.add(messageId);
            return session.channelSettings.showCompactionSummaries;
          }).pipe(
            Effect.flatMap((shouldProcess) =>
              shouldProcess
                ? readPromptResult(session.opencode, messageId).pipe(
                    Effect.flatMap((result) => sendCompactionSummary(session, result.transcript)),
                  )
                : Effect.void,
            ),
          ),
      },
      readPromptResult,
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    const summaryEvent = makeAssistantMessageUpdatedEvent({
      id: "summary-1",
      parentId: "synthetic-1",
      summary: true,
      mode: "compaction",
      completed: true,
    });

    await Effect.runPromise(runtime.handleEvent(summaryEvent));
    await Effect.runPromise(runtime.handleEvent(summaryEvent));

    expect(await getRef(readPromptCalls)).toEqual(["summary-1"]);
    expect(await getRef(sentSummaries)).toEqual(["summary text"]);
  });

  test("suppresses compaction summaries when the channel has them disabled", async () => {
    const { session } = await makeSession(false, false);
    const readPromptCalls = await Effect.runPromise(Ref.make<string[]>([]));
    const sentSummaries = await Effect.runPromise(Ref.make<string[]>([]));

    const readPromptResult = (_session: SessionHandle, messageId: string) =>
      Ref.update(readPromptCalls, (current) => [...current, messageId]).pipe(
        Effect.as({
          messageId,
          transcript: "summary text",
        }),
      );
    const sendCompactionSummary = (_session: ChannelSession, text: string) =>
      Ref.update(sentSummaries, (current) => [...current, text]).pipe(Effect.asVoid);

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(
          sessionId === session.opencode.sessionId ? { session, activeRun: null } : null,
        ),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: {
        ...noopIdleCompactionWorkflow,
        emitSummary: ({ session, messageId }) =>
          Effect.sync(() => {
            if (session.emittedCompactionSummaryMessageIds.has(messageId)) {
              return false;
            }
            session.emittedCompactionSummaryMessageIds.add(messageId);
            return session.channelSettings.showCompactionSummaries;
          }).pipe(
            Effect.flatMap((shouldProcess) =>
              shouldProcess
                ? readPromptResult(session.opencode, messageId).pipe(
                    Effect.flatMap((result) => sendCompactionSummary(session, result.transcript)),
                  )
                : Effect.void,
            ),
          ),
      },
      readPromptResult,
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(
      runtime.handleEvent(
        makeAssistantMessageUpdatedEvent({
          id: "summary-1",
          parentId: "synthetic-1",
          summary: true,
          mode: "compaction",
          completed: true,
        }),
      ),
    );

    expect(await getRef(readPromptCalls)).toEqual([]);
    expect(await getRef(sentSummaries)).toEqual([]);
    expect(session.emittedCompactionSummaryMessageIds.has("summary-1")).toBe(true);
  });

  test("keeps waiting for the follow-up assistant after an auto-compaction summary on the original user message", async () => {
    const { session, activeRun, progressQueue, promptState } = await makeSession(true);
    const completion = await Effect.runPromise(beginPendingPrompt(promptState));
    const readPromptCalls = await Effect.runPromise(Ref.make<string[]>([]));
    const sentSummaries = await Effect.runPromise(Ref.make<string[]>([]));

    const readPromptResult = (_session: SessionHandle, messageId: string) =>
      Ref.update(readPromptCalls, (current) => [...current, messageId]).pipe(
        Effect.as(
          messageId === "summary-1"
            ? {
                messageId,
                transcript: "summary text",
              }
            : {
                messageId,
                transcript: "final reply",
              },
        ),
      );
    const sendCompactionSummary = (_session: ChannelSession, text: string) =>
      Ref.update(sentSummaries, (current) => [...current, text]).pipe(Effect.asVoid);

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: {
        ...noopIdleCompactionWorkflow,
        emitSummary: ({ session, messageId }) =>
          Effect.sync(() => {
            if (session.emittedCompactionSummaryMessageIds.has(messageId)) {
              return false;
            }
            session.emittedCompactionSummaryMessageIds.add(messageId);
            return session.channelSettings.showCompactionSummaries;
          }).pipe(
            Effect.flatMap((shouldProcess) =>
              shouldProcess
                ? readPromptResult(session.opencode, messageId).pipe(
                    Effect.flatMap((result) => sendCompactionSummary(session, result.transcript)),
                  )
                : Effect.void,
            ),
          ),
      },
      readPromptResult,
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent()));
    await Effect.runPromise(
      runtime.handleEvent(
        makeAssistantMessageUpdatedEvent({
          id: "summary-1",
          parentId: "user-1",
          summary: true,
          mode: "compaction",
          completed: true,
        }),
      ),
    );

    expect(await getRef(readPromptCalls)).toEqual(["summary-1"]);
    expect(await getRef(sentSummaries)).toEqual(["summary text"]);
    expect(await Effect.runPromise(Queue.clear(progressQueue))).toEqual([]);
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent("user-2")));
    await Effect.runPromise(
      runtime.handleEvent(
        makeAssistantMessageUpdatedEvent({
          id: "assistant-1",
          parentId: "user-2",
          completed: true,
        }),
      ),
    );

    expect(await getRef(readPromptCalls)).toEqual(["summary-1"]);
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);

    await Effect.runPromise(runtime.handleEvent(makeSessionStatusEvent("session-1", "idle")));

    expect(await getRef(readPromptCalls)).toEqual(["summary-1", "assistant-1"]);
    expect(await Effect.runPromise(Deferred.await(completion))).toEqual({
      messageId: "assistant-1",
      transcript: "final reply",
    });
  });

  test("completes once session.status becomes idle even when tool progress was already observed", async () => {
    const { session, activeRun, progressQueue, promptState } = await makeSession(true);
    const completion = await Effect.runPromise(beginPendingPrompt(promptState));

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: noopIdleCompactionWorkflow,
      readPromptResult: (_session, messageId) =>
        Effect.succeed({
          messageId,
          transcript: "final reply",
        }),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent()));
    await Effect.runPromise(runtime.handleEvent(makeToolEvent("running")));
    await Effect.runPromise(
      runtime.handleEvent(
        makeAssistantMessageUpdatedEvent({
          id: "assistant-1",
          parentId: "user-1",
          completed: true,
        }),
      ),
    );

    expect(await Effect.runPromise(Queue.takeAll(progressQueue))).toEqual([
      {
        type: "tool-updated",
        part: makeToolPart("running"),
      },
    ]);
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);

    await Effect.runPromise(runtime.handleEvent(makeSessionStatusEvent("session-1", "idle")));

    expect(await Effect.runPromise(Deferred.await(completion))).toEqual({
      messageId: "assistant-1",
      transcript: "final reply",
    });
  });

  test("ignores completed tool updates that do not belong to the active run", async () => {
    const { session, activeRun, progressQueue, promptState } = await makeSession(true);
    const completion = await Effect.runPromise(beginPendingPrompt(promptState));

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: noopIdleCompactionWorkflow,
      readPromptResult: (_session, messageId) =>
        Effect.succeed({
          messageId,
          transcript: "final reply",
        }),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent()));
    await Effect.runPromise(
      runtime.handleEvent(
        makeAssistantMessageUpdatedEvent({
          id: "assistant-current",
          parentId: "user-1",
        }),
      ),
    );

    await Effect.runPromise(
      runtime.handleEvent(
        makeToolEvent("completed", {
          messageId: "assistant-old",
          callId: "call-old",
        }),
      ),
    );

    expect(await Effect.runPromise(Queue.clear(progressQueue))).toEqual([]);
    expect(activeRun?.observedToolCallIds.size).toBe(0);
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);
  });

  test("ignores terminal tool updates for stale assistants seen before prompt binding", async () => {
    const { session, activeRun, progressQueue, promptState } = await makeSession(true);
    const completion = await Effect.runPromise(beginPendingPrompt(promptState));

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: noopIdleCompactionWorkflow,
      readPromptResult: (_session, messageId) =>
        Effect.succeed({
          messageId,
          transcript: "final reply",
        }),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(
      runtime.handleEvent(
        makeAssistantMessageUpdatedEvent({
          id: "assistant-old",
          parentId: "user-old",
          completed: true,
        }),
      ),
    );
    await Effect.runPromise(
      runtime.handleEvent(
        makeToolEvent("completed", {
          messageId: "assistant-old",
          callId: "call-old",
        }),
      ),
    );

    expect(await Effect.runPromise(Queue.clear(progressQueue))).toEqual([]);
    expect(activeRun?.observedToolCallIds.size).toBe(0);
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent()));

    expect(await Effect.runPromise(Queue.clear(progressQueue))).toEqual([]);
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);
  });

  test("emits in-flight tool updates before the assistant message is bound", async () => {
    const { session, activeRun, progressQueue, promptState } = await makeSession(true);
    const completion = await Effect.runPromise(beginPendingPrompt(promptState));

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: noopIdleCompactionWorkflow,
      readPromptResult: (_session, messageId) =>
        Effect.succeed({
          messageId,
          transcript: "final reply",
        }),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(
      runtime.handleEvent(
        makeAssistantMessageUpdatedEvent({
          id: "assistant-1",
          parentId: "user-1",
          completed: true,
        }),
      ),
    );
    await Effect.runPromise(
      runtime.handleEvent(
        makeToolEvent("running", {
          messageId: "assistant-1",
          callId: "call-1",
        }),
      ),
    );

    expect(await Effect.runPromise(Queue.takeAll(progressQueue))).toEqual([
      {
        type: "tool-updated",
        part: makeToolPart("running"),
      },
    ]);
    expect(activeRun?.observedToolCallIds.has("call-1")).toBe(true);
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent()));

    expect(await Effect.runPromise(Queue.clear(progressQueue))).toEqual([]);
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);

    await Effect.runPromise(runtime.handleEvent(makeSessionStatusEvent("session-1", "idle")));

    expect(await Effect.runPromise(Deferred.await(completion))).toEqual({
      messageId: "assistant-1",
      transcript: "final reply",
    });
  });

  test("fails the pending prompt when the correlated assistant aborts", async () => {
    const { session, activeRun, promptState } = await makeSession(true);
    const completion = await Effect.runPromise(beginPendingPrompt(promptState));
    const readPromptCalls = await Effect.runPromise(Ref.make(0));

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: noopIdleCompactionWorkflow,
      readPromptResult: () =>
        Ref.update(readPromptCalls, (count) => count + 1).pipe(
          Effect.flatMap(() => Effect.fail(new Error("unexpected prompt result load"))),
        ),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent()));
    await Effect.runPromise(
      runtime.handleEvent(
        makeAssistantMessageUpdatedEvent({
          id: "assistant-1",
          parentId: "user-1",
          completed: true,
          error: {
            name: "MessageAbortedError",
            data: {
              message: "aborted",
            },
          },
        }),
      ),
    );

    const exit = await Effect.runPromise(Effect.exit(Deferred.await(completion)));
    expect(exit._tag).toBe("Failure");
    expect(await getRef(readPromptCalls)).toBe(0);
  });

  test("can bind the server-created user message after an assistant event arrives first", async () => {
    const { session, activeRun, promptState } = await makeSession(true);
    const completion = await Effect.runPromise(beginPendingPrompt(promptState));

    const runtime = createEventHandler({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      handleQuestionEvent: () => Effect.void,
      idleCompactionWorkflow: noopIdleCompactionWorkflow,
      readPromptResult: (_session, messageId) =>
        Effect.succeed({
          messageId,
          transcript: "final reply",
        }),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error) => String(error),
    });

    await Effect.runPromise(
      runtime.handleEvent(
        makeAssistantMessageUpdatedEvent({
          id: "assistant-1",
          parentId: "user-1",
          completed: true,
        }),
      ),
    );
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent()));

    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);
    await Effect.runPromise(runtime.handleEvent(makeSessionStatusEvent("session-1", "idle")));

    expect(await Effect.runPromise(Deferred.await(completion))).toEqual({
      messageId: "assistant-1",
      transcript: "final reply",
    });
  });
});
