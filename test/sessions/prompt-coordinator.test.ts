import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Queue, Ref } from "effect";
import type { Message } from "discord.js";

import { buildQueuedFollowUpPrompt } from "@/discord/messages.ts";
import { coordinateActiveRunPrompts } from "@/sessions/prompt-coordinator.ts";
import { createPromptState } from "@/sessions/prompt-state.ts";
import { enqueueRunRequest } from "@/sessions/request-routing.ts";
import type { RunRequest } from "@/sessions/session.ts";
import type { PromptResult, SessionHandle } from "@/opencode/service.ts";
import type { LoggerShape } from "@/util/logging.ts";
import { unsafeStub } from "../support/stub.ts";

const makeMessage = (id: string) =>
  unsafeStub<Message>({
    id,
    attachments: new Map(),
  });

const makeRequest = (
  id: string,
  prompt = `prompt-${id}`,
  attachmentMessageIds: ReadonlyArray<string> = [id],
): RunRequest => ({
  message: makeMessage(id),
  prompt,
  attachmentMessages: attachmentMessageIds.map((messageId) => makeMessage(messageId)),
});

const makeLogger = (): LoggerShape => ({
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
});

const makeSessionHandle = (): SessionHandle =>
  ({
    sessionId: "ses-1",
    client: {} as never,
    workdir: "/tmp/workdir",
    backend: "bwrap",
    close: () => Effect.void,
  }) satisfies SessionHandle;

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
        Effect.zipRight(Ref.set(activeRun.promptState, null)),
      );
    }),
  );

const makeActiveRunState = async () => ({
  attachmentMessagesById: new Map<string, Message>(),
  promptState: await Effect.runPromise(createPromptState()),
  followUpQueue: await Effect.runPromise(Queue.unbounded<RunRequest>()),
  acceptFollowUps: await Effect.runPromise(Ref.make(true)),
});

describe("coordinateActiveRunPrompts", () => {
  test("prompts the initial batch, absorbs queued follow-ups, and returns the last result", async () => {
    const activeRun = await makeActiveRunState();
    const submitCalls: string[] = [];
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
        session: makeSessionHandle(),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial", ["m-1"])],
        awaitIdleCompaction: () => Effect.void,
        submitPrompt,
        logger: makeLogger(),
      }),
    );

    expect(submitCalls).toEqual(["initial", buildQueuedFollowUpPrompt(["follow-1", "follow-2"])]);
    expect(result).toEqual({
      messageId: "msg-2",
      transcript: "reply-2",
    });
    expect([...activeRun.attachmentMessagesById.keys()]).toEqual(["m-1", "m-2", "m-3", "m-4"]);
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
        session: makeSessionHandle(),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial")],
        awaitIdleCompaction: () => Effect.void,
        submitPrompt,
        logger: makeLogger(),
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
        session: makeSessionHandle(),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial", ["m-1"])],
        awaitIdleCompaction: () => Effect.void,
        submitPrompt,
        logger: makeLogger(),
      }),
    );

    expect(submitCalls).toEqual(["initial", buildQueuedFollowUpPrompt(["later"])]);
    expect(result.messageId).toBe("msg-2");
    expect([...activeRun.attachmentMessagesById.keys()]).toEqual(["m-1", "m-2", "m-3"]);
    expect(
      await Effect.runPromise(Queue.takeAll(sessionQueue).pipe(Effect.map((items) => [...items]))),
    ).toEqual([]);
  });

  test("fails immediately when prompt submission fails", async () => {
    const activeRun = await makeActiveRunState();

    await expect(
      Effect.runPromise(
        coordinateActiveRunPrompts({
          channelId: "c-1",
          session: makeSessionHandle(),
          activeRun,
          initialRequests: [makeRequest("m-1", "initial")],
          awaitIdleCompaction: () => Effect.void,
          submitPrompt: () => Effect.fail(new Error("submit failed")),
          logger: makeLogger(),
        }),
      ),
    ).rejects.toThrow("submit failed");

    expect(await Effect.runPromise(Ref.get(activeRun.promptState))).toBeNull();
  });
});
