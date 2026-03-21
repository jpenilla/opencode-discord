import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Option, Ref } from "effect";

import type { PromptResult, SessionHandle } from "@/opencode/service.ts";
import type { IdleCompactionWorkflowShape } from "@/sessions/compaction/idle-compaction-workflow.ts";
import { createEventHandler } from "@/sessions/event-handler.ts";
import { beginPendingPrompt } from "@/sessions/run/prompt-state.ts";
import { type ActiveRun, type ChannelSession } from "@/sessions/session.ts";
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
import { getRef, makeSessionHandle, makeSilentLogger } from "../support/fixtures.ts";
import { failTest } from "../support/errors.ts";
import { appendRef, clearQueue, makeRef, takeAll } from "../support/runtime.ts";
import { makeTestSessionState } from "../support/session.ts";

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
const assistantEvent = (
  id = "assistant-1",
  parentId = "user-1",
  extra: Omit<Parameters<typeof makeAssistantMessageUpdatedEvent>[0], "id" | "parentId"> = {},
) => makeAssistantMessageUpdatedEvent({ id, parentId, ...extra });
const completedAssistant = (id = "assistant-1", parentId = "user-1") =>
  assistantEvent(id, parentId, { completed: true });
const userEvent = (id?: string) => makeUserMessageUpdatedEvent(id);
const idleEvent = (sessionId = "session-1") => makeSessionStatusEvent(sessionId, "idle");
const toolEvent = (status: "running" | "completed", messageId = "assistant-1", callId = "call-1") =>
  status === "running" && messageId === "assistant-1" && callId === "call-1"
    ? makeToolEvent(status)
    : makeToolEvent(status, { messageId, callId });
const handleEvents = (
  runtime: ReturnType<typeof makeRuntime>,
  ...events: Array<Parameters<ReturnType<typeof makeRuntime>["handleEvent"]>[0]>
) =>
  events.reduce(
    (promise, event) => promise.then(() => Effect.runPromise(runtime.handleEvent(event))),
    Promise.resolve(),
  );
const awaitCompletion = <A, E>(completion: Deferred.Deferred<A, E>) =>
  Effect.runPromise(Deferred.await(completion));
const expectFinalReply = async (
  completion: Deferred.Deferred<PromptResult, unknown>,
  messageId = "assistant-1",
) => {
  expect(await awaitCompletion(completion)).toEqual(finalReply(messageId));
};
const expectNoProgress = async (
  progressQueue: { takeAll?: never } & Parameters<typeof clearQueue>[0],
) => {
  expect(await clearQueue(progressQueue)).toEqual([]);
};
const expectRunningToolProgress = async (progressQueue: Parameters<typeof takeAll>[0]) => {
  expect(await takeAll(progressQueue)).toEqual([
    {
      type: "tool-updated",
      part: makeToolPart("running"),
    },
  ]);
};
const expectPending = async <A, E>(completion: Deferred.Deferred<A, E>) => {
  expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);
};

const makeSession = async (withActiveRun: boolean, showCompactionSummaries = true) => {
  return makeTestSessionState({
    withActiveRun,
    session: {
      opencode: makeSessionHandle(),
      channelSettings: {
        showThinking: true,
        showCompactionSummaries,
      },
    },
  });
};

const noopIdleCompactionWorkflow = {
  emitSummary: () => Effect.void,
  handleCompacted: () => Effect.void,
};

const unexpectedPromptResultLoad = () => failTest("unexpected prompt result load");
const makeSummaryHarness = async (
  transcriptFor: (messageId: string) => string = () => "summary text",
) => {
  const readPromptCalls = await makeRef<string[]>([]);
  const sentSummaries = await makeRef<string[]>([]);

  return {
    readPromptCalls,
    sentSummaries,
    readPromptResult: (_session: SessionHandle, messageId: string) =>
      appendRef(readPromptCalls, messageId).pipe(
        Effect.as({
          messageId,
          transcript: transcriptFor(messageId),
        }),
      ),
    sendCompactionSummary: (_session: ChannelSession, text: string) =>
      appendRef(sentSummaries, text).pipe(Effect.asVoid),
  };
};
const beginPendingRuntime = async (input?: {
  idleCompactionWorkflow?: Pick<IdleCompactionWorkflowShape, "emitSummary" | "handleCompacted">;
  readPromptResult?: (
    session: SessionHandle,
    messageId: string,
  ) => Effect.Effect<PromptResult, unknown>;
}) => {
  const pending = await beginPendingRun();
  return {
    ...pending,
    runtime: makeRuntime({
      session: pending.session,
      activeRun: pending.activeRun,
      idleCompactionWorkflow: input?.idleCompactionWorkflow,
      readPromptResult: input?.readPromptResult,
    }),
  };
};
const beginDefaultPendingRuntime = () => beginPendingRuntime({ readPromptResult: readFinalReply });

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

    expect(await takeAll(progressQueue)).toEqual([
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
    const summary = await makeSummaryHarness();

    const runtime = makeRuntime({
      session,
      idleCompactionWorkflow: makeSummaryWorkflow(summary),
      readPromptResult: summary.readPromptResult,
    });

    const summaryEvent = assistantEvent("summary-1", "synthetic-1", {
      summary: true,
      mode: "compaction",
      completed: true,
    });

    await handleEvents(runtime, summaryEvent, summaryEvent);

    expect(await getRef(summary.readPromptCalls)).toEqual(["summary-1"]);
    expect(await getRef(summary.sentSummaries)).toEqual(["summary text"]);
  });

  test("suppresses compaction summaries when the channel has them disabled", async () => {
    const { session } = await makeSession(false, false);
    const summary = await makeSummaryHarness();

    const runtime = makeRuntime({
      session,
      idleCompactionWorkflow: makeSummaryWorkflow(summary),
      readPromptResult: summary.readPromptResult,
    });

    await handleEvents(
      runtime,
      assistantEvent("summary-1", "synthetic-1", {
        summary: true,
        mode: "compaction",
        completed: true,
      }),
    );

    expect(await getRef(summary.readPromptCalls)).toEqual([]);
    expect(await getRef(summary.sentSummaries)).toEqual([]);
    expect(session.emittedCompactionSummaryMessageIds.has("summary-1")).toBe(true);
  });

  test("keeps waiting for the follow-up assistant after an auto-compaction summary on the original user message", async () => {
    const summary = await makeSummaryHarness((messageId) =>
      messageId === "summary-1" ? "summary text" : "final reply",
    );

    const { progressQueue, completion, runtime } = await beginPendingRuntime({
      idleCompactionWorkflow: makeSummaryWorkflow(summary),
      readPromptResult: summary.readPromptResult,
    });

    await handleEvents(
      runtime,
      userEvent(),
      assistantEvent("summary-1", "user-1", {
        summary: true,
        mode: "compaction",
        completed: true,
      }),
    );

    expect(await getRef(summary.readPromptCalls)).toEqual(["summary-1"]);
    expect(await getRef(summary.sentSummaries)).toEqual(["summary text"]);
    await expectNoProgress(progressQueue);
    await expectPending(completion);

    await handleEvents(
      runtime,
      userEvent("user-2"),
      assistantEvent("assistant-1", "user-2", { completed: true }),
    );

    expect(await getRef(summary.readPromptCalls)).toEqual(["summary-1"]);
    await expectPending(completion);

    await handleEvents(runtime, idleEvent());

    expect(await getRef(summary.readPromptCalls)).toEqual(["summary-1", "assistant-1"]);
    await expectFinalReply(completion);
  });

  test("completes once session.status becomes idle even when tool progress was already observed", async () => {
    const { progressQueue, completion, runtime } = await beginDefaultPendingRuntime();

    await handleEvents(runtime, userEvent(), toolEvent("running"), completedAssistant());

    await expectRunningToolProgress(progressQueue);
    await expectPending(completion);

    await handleEvents(runtime, idleEvent());

    await expectFinalReply(completion);
  });

  test("ignores completed tool updates that do not belong to the active run", async () => {
    const { activeRun, progressQueue, completion, runtime } = await beginDefaultPendingRuntime();

    await handleEvents(
      runtime,
      userEvent(),
      assistantEvent("assistant-current"),
      toolEvent("completed", "assistant-old", "call-old"),
    );

    await expectNoProgress(progressQueue);
    expect(activeRun?.observedToolCallIds.size).toBe(0);
    await expectPending(completion);
  });

  test("ignores terminal tool updates for stale assistants seen before prompt binding", async () => {
    const { activeRun, progressQueue, completion, runtime } = await beginDefaultPendingRuntime();

    await handleEvents(
      runtime,
      completedAssistant("assistant-old", "user-old"),
      toolEvent("completed", "assistant-old", "call-old"),
    );

    await expectNoProgress(progressQueue);
    expect(activeRun?.observedToolCallIds.size).toBe(0);
    await expectPending(completion);

    await handleEvents(runtime, userEvent());

    await expectNoProgress(progressQueue);
    await expectPending(completion);
  });

  test("emits in-flight tool updates before the assistant message is bound", async () => {
    const { activeRun, progressQueue, completion, runtime } = await beginDefaultPendingRuntime();

    await handleEvents(runtime, completedAssistant(), toolEvent("running"));

    await expectRunningToolProgress(progressQueue);
    expect(activeRun?.observedToolCallIds.has("call-1")).toBe(true);
    await expectPending(completion);

    await handleEvents(runtime, userEvent());

    await expectNoProgress(progressQueue);
    await expectPending(completion);

    await handleEvents(runtime, idleEvent());

    await expectFinalReply(completion);
  });

  test("fails the pending prompt when the correlated assistant aborts", async () => {
    const readPromptCalls = await makeRef(0);
    const { completion, runtime } = await beginPendingRuntime({
      readPromptResult: () =>
        Ref.update(readPromptCalls, (count) => count + 1).pipe(
          Effect.flatMap(() => failTest("unexpected prompt result load")),
        ),
    });

    await handleEvents(
      runtime,
      userEvent(),
      assistantEvent("assistant-1", "user-1", {
        completed: true,
        error: {
          name: "MessageAbortedError",
          data: {
            message: "aborted",
          },
        },
      }),
    );

    const exit = await Effect.runPromise(Effect.exit(Deferred.await(completion)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await getRef(readPromptCalls)).toBe(0);
  });

  test("can bind the server-created user message after an assistant event arrives first", async () => {
    const { completion, runtime } = await beginDefaultPendingRuntime();

    await handleEvents(runtime, completedAssistant());
    await expectPending(completion);

    await handleEvents(runtime, userEvent());

    await expectPending(completion);
    await handleEvents(runtime, idleEvent());

    await expectFinalReply(completion);
  });
});
