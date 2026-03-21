import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Option, Queue, Ref } from "effect";

import type { PromptResult, SessionHandle } from "@/opencode/service.ts";
import type { IdleCompactionWorkflowShape } from "@/sessions/compaction/idle-compaction-workflow.ts";
import { createEventHandler } from "@/sessions/event-handler.ts";
import { beginPendingPrompt, createPromptState } from "@/sessions/run/prompt-state.ts";
import { type ActiveRun, type ChannelSession, type RunProgressEvent } from "@/sessions/session.ts";
import {
  makeAssistantMessageUpdatedEvent,
  makeQuestionAskedEvent,
  makeQuestionRejectedEvent,
  makeQuestionRepliedEvent,
  makeSessionCompactedEvent,
  makeSessionStatusEvent,
  makeToolPart,
  makeToolEvent,
  makeUserMessageUpdatedEvent,
} from "../support/opencode-events.ts";
import { getRef, makeMessage, makeSessionHandle, makeSilentLogger } from "../support/fixtures.ts";
import { failTest } from "../support/errors.ts";
import { appendRef } from "../support/runtime.ts";
import { makeTestActiveRun, makeTestSession } from "../support/session.ts";
import { unsafeStub } from "../support/stub.ts";

const makeRef = <A>(value: A) => Effect.runPromise(Ref.make(value));

const beginPendingRun = async () => {
  const state = await makeSession(true);
  return {
    ...state,
    completion: await Effect.runPromise(beginPendingPrompt(state.promptState)),
  };
};

const finalReply = (messageId: string): PromptResult => ({
  messageId,
  transcript: "final reply",
});

const readFinalReply = (_session: SessionHandle, messageId: string) =>
  Effect.succeed(finalReply(messageId));
const takeAll = <A>(queue: Queue.Dequeue<A>) => Effect.runPromise(Queue.takeAll(queue));
const clearQueue = <A>(queue: Queue.Dequeue<A>) => Effect.runPromise(Queue.clear(queue));
const expectPending = async <A, E>(completion: Deferred.Deferred<A, E>) => {
  expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);
};

const makeSession = async (withActiveRun: boolean, showCompactionSummaries = true) => {
  const activeRunState = withActiveRun ? await makeTestActiveRun() : null;
  const activeRun = activeRunState?.activeRun ?? null;
  const progressQueue =
    activeRunState?.progressQueue ?? (await Effect.runPromise(Queue.unbounded<RunProgressEvent>()));
  const promptState = activeRun?.promptState ?? (await Effect.runPromise(createPromptState()));
  const session = makeTestSession({
    opencode: makeSessionHandle(),
    channelSettings: {
      showThinking: true,
      showCompactionSummaries,
    },
    activeRun,
  });

  return { session, activeRun, progressQueue, promptState };
};

const noopIdleCompactionWorkflow = {
  emitSummary: () => Effect.void,
  handleCompacted: () => Effect.void,
};

const unexpectedPromptResultLoad = () => failTest("unexpected prompt result load");

const makeRuntime = (input: {
  session?: ChannelSession | null;
  activeRun?: ActiveRun | null;
  getSessionContext?: (
    sessionId: string,
  ) => Effect.Effect<{ session: ChannelSession; activeRun: ActiveRun | null } | null>;
  handleQuestionEvent?: (event: unknown) => Effect.Effect<void>;
  idleCompactionWorkflow?: Pick<IdleCompactionWorkflowShape, "emitSummary" | "handleCompacted">;
  readPromptResult?: (
    session: SessionHandle,
    messageId: string,
  ) => Effect.Effect<PromptResult, unknown>;
}) =>
  createEventHandler({
    getSessionContext:
      input.getSessionContext ??
      ((sessionId) =>
        Effect.succeed(
          input.session && sessionId === input.session.opencode.sessionId
            ? { session: input.session, activeRun: input.activeRun ?? null }
            : null,
        )),
    handleQuestionEvent: input.handleQuestionEvent ?? (() => Effect.void),
    idleCompactionWorkflow: input.idleCompactionWorkflow ?? noopIdleCompactionWorkflow,
    readPromptResult: input.readPromptResult ?? unexpectedPromptResultLoad,
    logger: makeSilentLogger(),
    formatError: (error) => String(error),
  });

const makeSummaryWorkflow = (deps: {
  readPromptResult: (
    _session: SessionHandle,
    messageId: string,
  ) => Effect.Effect<PromptResult, unknown>;
  sendCompactionSummary: (_session: ChannelSession, text: string) => Effect.Effect<void, unknown>;
}): Pick<IdleCompactionWorkflowShape, "emitSummary" | "handleCompacted"> => ({
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
        !shouldProcess
          ? Effect.void
          : deps
              .readPromptResult(session.opencode, messageId)
              .pipe(
                Effect.flatMap((result) => deps.sendCompactionSummary(session, result.transcript)),
              ),
      ),
    ),
});

describe("createEventHandler", () => {
  test("routes question asked events to the question coordinator", async () => {
    const { session } = await makeSession(false);
    const questionEvents = await makeRef<unknown[]>([]);

    const runtime = makeRuntime({
      session,
      handleQuestionEvent: (event) => appendRef(questionEvents, event),
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
    const questionEvents = await makeRef<unknown[]>([]);

    const runtime = makeRuntime({
      session,
      handleQuestionEvent: (event) => appendRef(questionEvents, event),
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

    const runtime = makeRuntime({ session, activeRun });

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
    const idleUpdates = await makeRef<string[]>([]);

    const runtime = makeRuntime({
      session,
      idleCompactionWorkflow: {
        ...noopIdleCompactionWorkflow,
        handleCompacted: (sessionId) => appendRef(idleUpdates, sessionId),
      },
    });

    await Effect.runPromise(runtime.handleEvent(makeSessionCompactedEvent()));

    expect(await getRef(idleUpdates)).toEqual(["session-1"]);
  });

  test("ignores events for sessions that are not currently tracked", async () => {
    const questionEvents = await makeRef(0);
    const idleUpdates = await makeRef(0);

    const runtime = makeRuntime({
      getSessionContext: () => Effect.succeed(null),
      handleQuestionEvent: () => Ref.update(questionEvents, (count) => count + 1),
      idleCompactionWorkflow: {
        ...noopIdleCompactionWorkflow,
        handleCompacted: () => Ref.update(idleUpdates, (count) => count + 1),
      },
    });

    await Effect.runPromise(runtime.handleEvent(makeQuestionAskedEvent("missing-session")));
    await Effect.runPromise(runtime.handleEvent(makeSessionCompactedEvent("missing-session")));

    expect(await getRef(questionEvents)).toBe(0);
    expect(await getRef(idleUpdates)).toBe(0);
  });

  test("emits a late compaction summary once even after the active run is gone", async () => {
    const { session } = await makeSession(false);
    const readPromptCalls = await makeRef<string[]>([]);
    const sentSummaries = await makeRef<string[]>([]);

    const readPromptResult = (_session: SessionHandle, messageId: string) =>
      appendRef(readPromptCalls, messageId).pipe(
        Effect.as({
          messageId,
          transcript: "summary text",
        }),
      );
    const sendCompactionSummary = (_session: ChannelSession, text: string) =>
      appendRef(sentSummaries, text).pipe(Effect.asVoid);

    const runtime = makeRuntime({
      session,
      idleCompactionWorkflow: makeSummaryWorkflow({ readPromptResult, sendCompactionSummary }),
      readPromptResult,
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
    const readPromptCalls = await makeRef<string[]>([]);
    const sentSummaries = await makeRef<string[]>([]);

    const readPromptResult = (_session: SessionHandle, messageId: string) =>
      appendRef(readPromptCalls, messageId).pipe(
        Effect.as({
          messageId,
          transcript: "summary text",
        }),
      );
    const sendCompactionSummary = (_session: ChannelSession, text: string) =>
      appendRef(sentSummaries, text).pipe(Effect.asVoid);

    const runtime = makeRuntime({
      session,
      idleCompactionWorkflow: makeSummaryWorkflow({ readPromptResult, sendCompactionSummary }),
      readPromptResult,
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
    const { session, activeRun, progressQueue, completion } = await beginPendingRun();
    const readPromptCalls = await makeRef<string[]>([]);
    const sentSummaries = await makeRef<string[]>([]);

    const readPromptResult = (_session: SessionHandle, messageId: string) =>
      appendRef(readPromptCalls, messageId).pipe(
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
      appendRef(sentSummaries, text).pipe(Effect.asVoid);

    const runtime = makeRuntime({
      session,
      activeRun,
      idleCompactionWorkflow: makeSummaryWorkflow({ readPromptResult, sendCompactionSummary }),
      readPromptResult,
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
    expect(await clearQueue(progressQueue)).toEqual([]);
    await expectPending(completion);

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
    await expectPending(completion);

    await Effect.runPromise(runtime.handleEvent(makeSessionStatusEvent("session-1", "idle")));

    expect(await getRef(readPromptCalls)).toEqual(["summary-1", "assistant-1"]);
    expect(await Effect.runPromise(Deferred.await(completion))).toEqual({
      messageId: "assistant-1",
      transcript: "final reply",
    });
  });

  test("completes once session.status becomes idle even when tool progress was already observed", async () => {
    const { session, activeRun, progressQueue, completion } = await beginPendingRun();

    const runtime = makeRuntime({
      session,
      activeRun,
      readPromptResult: readFinalReply,
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

    expect(await takeAll(progressQueue)).toEqual([
      {
        type: "tool-updated",
        part: makeToolPart("running"),
      },
    ]);
    await expectPending(completion);

    await Effect.runPromise(runtime.handleEvent(makeSessionStatusEvent("session-1", "idle")));

    expect(await Effect.runPromise(Deferred.await(completion))).toEqual({
      messageId: "assistant-1",
      transcript: "final reply",
    });
  });

  test("ignores completed tool updates that do not belong to the active run", async () => {
    const { session, activeRun, progressQueue, completion } = await beginPendingRun();

    const runtime = makeRuntime({
      session,
      activeRun,
      readPromptResult: readFinalReply,
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

    expect(await clearQueue(progressQueue)).toEqual([]);
    expect(activeRun?.observedToolCallIds.size).toBe(0);
    await expectPending(completion);
  });

  test("ignores terminal tool updates for stale assistants seen before prompt binding", async () => {
    const { session, activeRun, progressQueue, completion } = await beginPendingRun();

    const runtime = makeRuntime({
      session,
      activeRun,
      readPromptResult: readFinalReply,
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

    expect(await clearQueue(progressQueue)).toEqual([]);
    expect(activeRun?.observedToolCallIds.size).toBe(0);
    await expectPending(completion);

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent()));

    expect(await clearQueue(progressQueue)).toEqual([]);
    await expectPending(completion);
  });

  test("emits in-flight tool updates before the assistant message is bound", async () => {
    const { session, activeRun, progressQueue, completion } = await beginPendingRun();

    const runtime = makeRuntime({
      session,
      activeRun,
      readPromptResult: readFinalReply,
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

    expect(await takeAll(progressQueue)).toEqual([
      {
        type: "tool-updated",
        part: makeToolPart("running"),
      },
    ]);
    expect(activeRun?.observedToolCallIds.has("call-1")).toBe(true);
    await expectPending(completion);

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent()));

    expect(await clearQueue(progressQueue)).toEqual([]);
    await expectPending(completion);

    await Effect.runPromise(runtime.handleEvent(makeSessionStatusEvent("session-1", "idle")));

    expect(await Effect.runPromise(Deferred.await(completion))).toEqual({
      messageId: "assistant-1",
      transcript: "final reply",
    });
  });

  test("fails the pending prompt when the correlated assistant aborts", async () => {
    const { session, activeRun, completion } = await beginPendingRun();
    const readPromptCalls = await makeRef(0);

    const runtime = makeRuntime({
      session,
      activeRun,
      readPromptResult: () =>
        Ref.update(readPromptCalls, (count) => count + 1).pipe(
          Effect.flatMap(() => failTest("unexpected prompt result load")),
        ),
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
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await getRef(readPromptCalls)).toBe(0);
  });

  test("can bind the server-created user message after an assistant event arrives first", async () => {
    const { session, activeRun, completion } = await beginPendingRun();

    const runtime = makeRuntime({
      session,
      activeRun,
      readPromptResult: readFinalReply,
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
    await expectPending(completion);

    await Effect.runPromise(runtime.handleEvent(makeUserMessageUpdatedEvent()));

    await expectPending(completion);
    await Effect.runPromise(runtime.handleEvent(makeSessionStatusEvent("session-1", "idle")));

    expect(await Effect.runPromise(Deferred.await(completion))).toEqual({
      messageId: "assistant-1",
      transcript: "final reply",
    });
  });
});
