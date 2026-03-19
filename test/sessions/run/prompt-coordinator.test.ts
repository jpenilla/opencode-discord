import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Queue, Ref } from "effect";
import type { Message } from "discord.js";

import { buildQueuedFollowUpPrompt } from "@/discord/messages.ts";
import { coordinateActiveRunPrompts } from "@/sessions/run/prompt-coordinator.ts";
import type { AdmittedPromptContext } from "@/sessions/run/prompt-context.ts";
import { createPromptState } from "@/sessions/run/prompt-state.ts";
import { enqueueRunRequest } from "@/sessions/request-routing.ts";
import type { RunRequest } from "@/sessions/session.ts";
import type { PromptResult, SessionHandle } from "@/opencode/service.ts";
import { makeMessage, makeSessionHandle, makeSilentLogger } from "../../support/fixtures.ts";

const makeRequest = (
  id: string,
  prompt = `prompt-${id}`,
  attachmentMessageIds: ReadonlyArray<string> = [id],
): RunRequest => ({
  message: makeMessage(id),
  prompt,
  attachmentMessages: attachmentMessageIds.map((messageId) => makeMessage(messageId)),
});

const resolveCurrentPrompt = (
  activeRun: Awaited<ReturnType<typeof makeActiveRunState>>,
  result: PromptResult,
) =>
  Ref.get(activeRun.promptState).pipe(
    Effect.flatMap((prompt) => {
      if (!prompt) {
        throw new Error("expected a pending prompt");
      }

      return Deferred.succeed(prompt.deferred, result).pipe(
        Effect.ignore,
        Effect.andThen(Ref.set(activeRun.promptState, null)),
      );
    }),
  );

const makeActiveRunState = async () => ({
  attachmentMessagesById: new Map<string, Message>(),
  currentPromptContext: null as AdmittedPromptContext | null,
  previousPromptMessageIds: new Set<string>(["user-old", "assistant-old"]),
  currentPromptMessageIds: new Set<string>(),
  currentPromptUserMessageId: "stale-user",
  assistantMessageParentIds: new Map<string, string>([["assistant-old", "stale-user"]]),
  observedToolCallIds: new Set<string>(["call-old"]),
  promptState: await Effect.runPromise(createPromptState()),
  followUpQueue: await Effect.runPromise(Queue.unbounded<RunRequest>()),
  acceptFollowUps: await Effect.runPromise(Ref.make(true)),
  interruptRequested: false,
  interruptSource: null,
});

describe("coordinateActiveRunPrompts", () => {
  test("prompts the initial batch, absorbs queued follow-ups, and returns the last result", async () => {
    const activeRun = await makeActiveRunState();
    const submitCalls: string[] = [];
    const completedPrompts: Array<{ kind: "initial" | "follow-up"; transcript: string }> = [];
    const submitPrompt = (_session: SessionHandle, value: string) =>
      Effect.gen(function* () {
        const callIndex = submitCalls.push(value);
        yield* resolveCurrentPrompt(activeRun, {
          messageId: `msg-${callIndex}`,
          transcript: `reply-${callIndex}`,
        });
      });

    await Effect.runPromise(
      Queue.offerAll(activeRun.followUpQueue, [
        makeRequest("m-2", "follow-1", ["m-2", "m-3"]),
        makeRequest("m-4", "follow-2", ["m-4"]),
      ]),
    );

    const result = await Effect.runPromise(
      coordinateActiveRunPrompts({
        channelId: "c-1",
        session: makeSessionHandle({ sessionId: "ses-1", workdir: "/tmp/workdir" }),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial", ["m-1"])],
        awaitIdleCompaction: () => Effect.void,
        submitPrompt,
        handlePromptCompleted: (promptContext, result) =>
          Effect.sync(() => {
            completedPrompts.push({
              kind: promptContext.kind,
              transcript: result.transcript,
            });
          }),
        logger: makeSilentLogger(),
      }),
    );

    expect(submitCalls).toEqual(["initial", buildQueuedFollowUpPrompt(["follow-1", "follow-2"])]);
    expect(result).toEqual({
      messageId: "msg-2",
      transcript: "reply-2",
    });
    expect([...activeRun.attachmentMessagesById.keys()]).toEqual(["m-1", "m-2", "m-3", "m-4"]);
    expect(activeRun.currentPromptContext?.kind).toBe("follow-up");
    expect(activeRun.currentPromptContext?.replyTargetMessage.id).toBe("m-4");
    expect(activeRun.currentPromptContext?.requestMessages.map((message) => message.id)).toEqual([
      "m-2",
      "m-4",
    ]);
    expect(completedPrompts).toEqual([
      {
        kind: "initial",
        transcript: "reply-1",
      },
      {
        kind: "follow-up",
        transcript: "reply-2",
      },
    ]);
  });

  test("reopens follow-up intake before the follow-up prompt and leaves it closed on exit", async () => {
    const activeRun = await makeActiveRunState();
    const gateSnapshots: boolean[] = [];
    const submitPrompt = (_session: SessionHandle, _value: string) =>
      Ref.get(activeRun.acceptFollowUps).pipe(
        Effect.tap(() =>
          resolveCurrentPrompt(activeRun, {
            messageId: `msg-${gateSnapshots.length + 1}`,
            transcript: `reply-${gateSnapshots.length + 1}`,
          }).pipe(Effect.ignore),
        ),
        Effect.map((gate) => {
          gateSnapshots.push(gate);
          return undefined;
        }),
      );

    await Effect.runPromise(Queue.offer(activeRun.followUpQueue, makeRequest("m-2", "follow-up")));

    await Effect.runPromise(
      coordinateActiveRunPrompts({
        channelId: "c-1",
        session: makeSessionHandle({ sessionId: "ses-1", workdir: "/tmp/workdir" }),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial")],
        awaitIdleCompaction: () => Effect.void,
        submitPrompt,
        handlePromptCompleted: () => Effect.void,
        logger: makeSilentLogger(),
      }),
    );

    expect(gateSnapshots).toEqual([true, true]);
    expect(await Effect.runPromise(Ref.get(activeRun.acceptFollowUps))).toBe(false);
  });

  test("absorbs a follow-up queued while the first prompt is running", async () => {
    const activeRun = await makeActiveRunState();
    const sessionQueue = await Effect.runPromise(Queue.unbounded<RunRequest>());
    const session = {
      queue: sessionQueue,
      activeRun,
    } satisfies Parameters<typeof enqueueRunRequest>[0];
    const submitCalls: string[] = [];
    const queuedFollowUp = makeRequest("m-2", "later", ["m-2", "m-3"]);

    const submitPrompt = (_session: SessionHandle, value: string) =>
      Effect.gen(function* () {
        const callIndex = submitCalls.push(value);
        if (callIndex === 1) {
          const destination = yield* enqueueRunRequest(session, queuedFollowUp);
          expect(destination).toBe("follow-up");
        }
        yield* resolveCurrentPrompt(activeRun, {
          messageId: `msg-${callIndex}`,
          transcript: `reply-${callIndex}`,
        });
      });

    const result = await Effect.runPromise(
      coordinateActiveRunPrompts({
        channelId: "c-1",
        session: makeSessionHandle({ sessionId: "ses-1", workdir: "/tmp/workdir" }),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial", ["m-1"])],
        awaitIdleCompaction: () => Effect.void,
        submitPrompt,
        handlePromptCompleted: () => Effect.void,
        logger: makeSilentLogger(),
      }),
    );

    expect(submitCalls).toEqual(["initial", buildQueuedFollowUpPrompt(["later"])]);
    expect(result.messageId).toBe("msg-2");
    expect([...activeRun.attachmentMessagesById.keys()]).toEqual(["m-1", "m-2", "m-3"]);
    expect(
      await Effect.runPromise(Queue.clear(sessionQueue).pipe(Effect.map((items) => [...items]))),
    ).toEqual([]);
  });

  test("does not start an absorbed follow-up after interrupt is requested", async () => {
    const activeRun = await makeActiveRunState();
    const sessionQueue = await Effect.runPromise(Queue.unbounded<RunRequest>());
    const session = {
      queue: sessionQueue,
      activeRun,
    } satisfies Parameters<typeof enqueueRunRequest>[0];
    const submitCalls: string[] = [];

    const submitPrompt = (_session: SessionHandle, value: string) =>
      Effect.gen(function* () {
        const callIndex = submitCalls.push(value);
        if (callIndex === 1) {
          const destination = yield* enqueueRunRequest(session, makeRequest("m-2", "follow-up"));
          expect(destination).toBe("follow-up");
        }
        yield* resolveCurrentPrompt(activeRun, {
          messageId: `msg-${callIndex}`,
          transcript: `reply-${callIndex}`,
        });
      });

    await expect(
      Effect.runPromise(
        coordinateActiveRunPrompts({
          channelId: "c-1",
          session: makeSessionHandle({ sessionId: "ses-1", workdir: "/tmp/workdir" }),
          activeRun,
          initialRequests: [makeRequest("m-1", "initial")],
          awaitIdleCompaction: () => Effect.void,
          submitPrompt,
          handlePromptCompleted: () =>
            Effect.sync(() => {
              activeRun.interruptRequested = true;
            }),
          logger: makeSilentLogger(),
        }),
      ),
    ).rejects.toThrow("interrupted");

    expect(submitCalls).toEqual(["initial"]);
    expect(
      await Effect.runPromise(Queue.clear(sessionQueue).pipe(Effect.map((items) => [...items]))),
    ).toEqual([]);
  });

  test("resets prompt-scoped tracking before each prompt submission", async () => {
    const activeRun = await makeActiveRunState();
    const snapshots: Array<{
      userMessageId: string | null;
      assistantCount: number;
      toolCallCount: number;
      promptKind: "initial" | "follow-up" | null;
      replyTargetMessageId: string | null;
    }> = [];
    const submitPrompt = (_session: SessionHandle, _value: string) =>
      Effect.gen(function* () {
        snapshots.push({
          userMessageId: activeRun.currentPromptUserMessageId,
          assistantCount: activeRun.assistantMessageParentIds.size,
          toolCallCount: activeRun.observedToolCallIds.size,
          promptKind: activeRun.currentPromptContext?.kind ?? null,
          replyTargetMessageId: activeRun.currentPromptContext?.replyTargetMessage.id ?? null,
        });
        yield* resolveCurrentPrompt(activeRun, {
          messageId: `msg-${snapshots.length}`,
          transcript: `reply-${snapshots.length}`,
        });
      });

    await Effect.runPromise(Queue.offer(activeRun.followUpQueue, makeRequest("m-2", "follow-up")));

    await Effect.runPromise(
      coordinateActiveRunPrompts({
        channelId: "c-1",
        session: makeSessionHandle({ sessionId: "ses-1", workdir: "/tmp/workdir" }),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial")],
        awaitIdleCompaction: () => Effect.void,
        submitPrompt,
        handlePromptCompleted: () => Effect.void,
        logger: makeSilentLogger(),
      }),
    );

    expect(snapshots).toEqual([
      {
        userMessageId: null,
        assistantCount: 0,
        toolCallCount: 0,
        promptKind: "initial",
        replyTargetMessageId: "m-1",
      },
      {
        userMessageId: null,
        assistantCount: 0,
        toolCallCount: 0,
        promptKind: "follow-up",
        replyTargetMessageId: "m-2",
      },
    ]);
  });

  test("rotates prompt message lineage across multiple absorbed follow-ups", async () => {
    const activeRun = await makeActiveRunState();
    const sessionQueue = await Effect.runPromise(Queue.unbounded<RunRequest>());
    const session = {
      queue: sessionQueue,
      activeRun,
    } satisfies Parameters<typeof enqueueRunRequest>[0];
    const snapshots: Array<{
      previous: string[];
      current: string[];
    }> = [];

    const submitPrompt = (_session: SessionHandle, _value: string) =>
      Effect.gen(function* () {
        const callIndex = snapshots.length + 1;
        snapshots.push({
          previous: [...activeRun.previousPromptMessageIds],
          current: [...activeRun.currentPromptMessageIds],
        });

        activeRun.currentPromptMessageIds.add(`user-${callIndex}`);
        activeRun.currentPromptMessageIds.add(`assistant-${callIndex}`);

        if (callIndex === 2) {
          const destination = yield* enqueueRunRequest(session, makeRequest("m-3", "follow-2"));
          expect(destination).toBe("follow-up");
        }

        yield* resolveCurrentPrompt(activeRun, {
          messageId: `msg-${callIndex}`,
          transcript: `reply-${callIndex}`,
        });
      });

    await Effect.runPromise(Queue.offer(activeRun.followUpQueue, makeRequest("m-2", "follow-1")));

    await Effect.runPromise(
      coordinateActiveRunPrompts({
        channelId: "c-1",
        session: makeSessionHandle({ sessionId: "ses-1", workdir: "/tmp/workdir" }),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial")],
        awaitIdleCompaction: () => Effect.void,
        submitPrompt,
        handlePromptCompleted: () => Effect.void,
        logger: makeSilentLogger(),
      }),
    );

    expect(snapshots).toEqual([
      {
        previous: [],
        current: [],
      },
      {
        previous: ["user-1", "assistant-1"],
        current: [],
      },
      {
        previous: ["user-2", "assistant-2"],
        current: [],
      },
    ]);
    expect([...activeRun.previousPromptMessageIds]).toEqual(["user-2", "assistant-2"]);
    expect([...activeRun.currentPromptMessageIds]).toEqual(["user-3", "assistant-3"]);
    expect(
      await Effect.runPromise(Queue.clear(sessionQueue).pipe(Effect.map((items) => [...items]))),
    ).toEqual([]);
  });

  test("fails immediately when prompt submission fails", async () => {
    const activeRun = await makeActiveRunState();

    await expect(
      Effect.runPromise(
        coordinateActiveRunPrompts({
          channelId: "c-1",
          session: makeSessionHandle({ sessionId: "ses-1", workdir: "/tmp/workdir" }),
          activeRun,
          initialRequests: [makeRequest("m-1", "initial")],
          awaitIdleCompaction: () => Effect.void,
          submitPrompt: () => Effect.fail(new Error("submit failed")),
          handlePromptCompleted: () => Effect.void,
          logger: makeSilentLogger(),
        }),
      ),
    ).rejects.toThrow("submit failed");

    expect(await Effect.runPromise(Ref.get(activeRun.promptState))).toBeNull();
  });
});
