import { describe, expect, test } from "bun:test";
import type {
  Message,
  MessageCreateOptions,
  MessageEditOptions,
  SendableChannels,
} from "discord.js";
import type { CompactionPart, ToolPart } from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Fiber, Queue } from "effect";

import {
  maxProgressBatchSize,
  runProgressWorker,
  takeProgressBatch,
} from "@/sessions/run/progress.ts";
import type { ChannelSession, RunProgressEvent } from "@/sessions/types.ts";
import { cardText, makePostedMessage, makeSendableChannel } from "../../support/discord.ts";
import { makeDeferred, runTestEffect } from "../../support/runtime.ts";
import { unsafeStub } from "../../support/stub.ts";

const makeHarness = async (showThinking = true) => {
  const sentPayloads: Array<MessageCreateOptions | MessageEditOptions> = [];
  const editedPayloads: Array<MessageCreateOptions | MessageEditOptions> = [];
  let nextMessageId = 0;

  const nextPostedMessage = (): Message => {
    nextMessageId += 1;
    const id = `card-${nextMessageId}`;
    return makePostedMessage(id, (payload: MessageEditOptions) =>
      Promise.resolve(editedPayloads.push(payload)).then(() => nextPostedMessage()),
    );
  };

  const sourceMessage = unsafeStub<Message>({
    id: "source-message",
    author: {
      id: "user-1",
      username: "user",
      globalName: null,
    },
    inGuild: () => false,
    member: null,
    guild: null,
    channel: makeSendableChannel({
      send: (payload: MessageCreateOptions) =>
        Promise.resolve(sentPayloads.push(payload)).then(() => nextPostedMessage()),
    }),
  });

  return {
    session: unsafeStub<ChannelSession>({
      channelSettings: {
        showThinking,
        showCompactionSummaries: true,
      },
      opencode: {
        backend: "bwrap",
      },
    }),
    sourceMessage,
    sentPayloads,
    editedPayloads,
  };
};

const startProgressWorker = (
  harness: Awaited<ReturnType<typeof makeHarness>>,
  queue: Queue.Queue<RunProgressEvent>,
) =>
  Effect.forkChild(
    runProgressWorker(
      harness.sourceMessage.channel as SendableChannels,
      harness.session,
      harness.sourceMessage,
      queue,
    ),
  );

const makeToolPart = (
  status: "running" | "completed" | "error",
  input?: {
    callId?: string;
    title?: string;
  },
): ToolPart =>
  unsafeStub<ToolPart>({
    id: "part-1",
    sessionID: "session-1",
    messageID: "assistant-1",
    callID: input?.callId ?? "call-1",
    tool: "bash",
    state: {
      status,
      input: {
        command: "pwd",
      },
      ...(status === "error" ? { error: "aborted" } : { title: input?.title ?? "Print cwd" }),
      time:
        status === "running"
          ? {
              start: 1,
            }
          : {
              start: 1,
              end: 2,
            },
    },
  });

const makeCompactionPart = (): CompactionPart =>
  unsafeStub<CompactionPart>({
    id: "compaction-1",
    sessionID: "session-1",
    messageID: "assistant-1",
    type: "compaction",
    auto: false,
  });

const makeReasoningCompletedEvent = (index: number): RunProgressEvent => ({
  type: "reasoning-completed",
  partId: `reasoning-${index}`,
  text: `thinking ${index}`,
});

const reasoningIds = (events: ReadonlyArray<RunProgressEvent>) =>
  events.map((event) => {
    if (event.type !== "reasoning-completed") {
      throw new Error("expected reasoning-completed events");
    }
    return event.partId;
  });

const runWorkerScenario = async <A>(input: {
  harness: Awaited<ReturnType<typeof makeHarness>>;
  events: RunProgressEvent[];
  beforeEvents?: (queue: Queue.Queue<RunProgressEvent>) => Effect.Effect<void>;
  afterEvents?: (queue: Queue.Queue<RunProgressEvent>) => Effect.Effect<void>;
  collect: (harness: Awaited<ReturnType<typeof makeHarness>>) => Effect.Effect<A, never, never>;
}) =>
  runTestEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<RunProgressEvent>();
        const worker = yield* startProgressWorker(input.harness, queue);

        yield* input.beforeEvents?.(queue) ?? Effect.void;
        yield* Queue.offerAll(queue, input.events);
        yield* input.afterEvents?.(queue) ?? Effect.void;
        yield* Fiber.interrupt(worker);

        return yield* input.collect(input.harness);
      }),
    ),
  );

const collectCards = (harness: Awaited<ReturnType<typeof makeHarness>>) =>
  Effect.succeed({ sent: harness.sentPayloads, edited: harness.editedPayloads });

const finalizeEvent = (ack: Deferred.Deferred<void>, reason?: "interrupted"): RunProgressEvent => ({
  type: "run-finalizing",
  ack,
  reason,
});

const awaitAck = (ack: Deferred.Deferred<void>) => Deferred.await(ack);

const runFinalizationScenario = async (reason: "interrupted") => {
  const harness = await makeHarness();
  const ack = await makeDeferred<void>();

  return runWorkerScenario({
    harness,
    events: [
      {
        type: "tool-updated",
        part: makeToolPart("running"),
      },
      {
        type: "session-compacting",
        part: makeCompactionPart(),
      },
      finalizeEvent(ack, reason),
    ],
    afterEvents: () => awaitAck(ack),
    collect: collectCards,
  });
};

describe("takeProgressBatch", () => {
  test("blocks until the first event arrives and preserves queued overflow for the next drain", async () => {
    const queue = await runTestEffect(Queue.unbounded<RunProgressEvent>());
    const events = Array.from({ length: maxProgressBatchSize + 5 }, (_, index) =>
      makeReasoningCompletedEvent(index + 1),
    );

    const { firstBatch, secondBatch } = await runTestEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* takeProgressBatch(queue).pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          expect(yield* Effect.sync(() => fiber.pollUnsafe())).toBeUndefined();

          yield* Queue.offerAll(queue, events);

          return {
            firstBatch: yield* Fiber.join(fiber),
            secondBatch: yield* takeProgressBatch(queue),
          };
        }),
      ),
    );

    expect(firstBatch).toHaveLength(maxProgressBatchSize);
    expect(reasoningIds(firstBatch)[0]).toBe("reasoning-1");
    expect(reasoningIds(firstBatch).at(-1)).toBe(`reasoning-${maxProgressBatchSize}`);
    expect(reasoningIds(secondBatch)).toEqual([
      "reasoning-66",
      "reasoning-67",
      "reasoning-68",
      "reasoning-69",
      "reasoning-70",
    ]);
  });
});

describe("runProgressWorker", () => {
  test("ignores session-compacted without an active compaction in this worker", async () => {
    const harness = await makeHarness();
    const ack = await makeDeferred<void>();

    const result = await runWorkerScenario({
      harness,
      events: [
        {
          type: "session-compacted",
          compacted: {
            sessionID: "session-1",
          },
        },
        finalizeEvent(ack),
      ],
      afterEvents: () => awaitAck(ack),
      collect: collectCards,
    });

    expect(result.sent.map(cardText)).toEqual([]);
    expect(result.edited.map(cardText)).toEqual([]);
  });

  test("updates the live compaction card to interrupted", async () => {
    const result = await runFinalizationScenario("interrupted");

    expect(result.sent.map(cardText)).toContain("**💻 🛠️ `bash` Running**\n`pwd`\nPrint cwd");
    expect(result.sent.map(cardText)).toContain(
      "**🗜️ Compacting session**\nOpenCode is summarizing earlier context for this session.",
    );
    expect(result.edited.map(cardText)).toContain(
      "**‼️ Compaction interrupted**\nOpenCode stopped compacting this session because the run was interrupted.",
    );
  });

  test("ignores a late session-compacted event after interrupted compaction finalization", async () => {
    const harness = await makeHarness();
    const firstAck = await makeDeferred<void>();
    const secondAck = await makeDeferred<void>();

    const result = await runWorkerScenario({
      harness,
      events: [
        {
          type: "session-compacting",
          part: makeCompactionPart(),
        },
        finalizeEvent(firstAck, "interrupted"),
      ],
      afterEvents: (queue) =>
        awaitAck(firstAck).pipe(
          Effect.andThen(
            Queue.offerAll(queue, [
              {
                type: "session-compacted",
                compacted: {
                  sessionID: "session-1",
                },
              },
              finalizeEvent(secondAck),
            ]),
          ),
          Effect.andThen(awaitAck(secondAck)),
        ),
      collect: collectCards,
    });

    expect(result.sent.map(cardText)).toContain(
      "**🗜️ Compacting session**\nOpenCode is summarizing earlier context for this session.",
    );
    expect(result.edited.map(cardText)).toEqual([
      "**‼️ Compaction interrupted**\nOpenCode stopped compacting this session because the run was interrupted.",
    ]);
  });

  test("updates live tool and compaction cards to interrupted on finalization", async () => {
    const result = await runFinalizationScenario("interrupted");

    expect(result.edited.map(cardText)).toContain(
      "**💻 ‼️ `bash` Interrupted**\n`pwd`\nPrint cwd\nNote: This tool did not complete because the run was interrupted.",
    );
    expect(result.edited.map(cardText)).toContain(
      "**‼️ Compaction interrupted**\nOpenCode stopped compacting this session because the run was interrupted.",
    );
  });

  test("sends completed thinking messages when enabled for the channel", async () => {
    const harness = await makeHarness(true);
    const ack = await makeDeferred<void>();

    const result = await runWorkerScenario({
      harness,
      events: [
        {
          type: "reasoning-completed",
          partId: "reasoning-1",
          text: "planning the change",
        },
        finalizeEvent(ack),
      ],
      afterEvents: () => awaitAck(ack),
      collect: (currentHarness) => Effect.succeed(currentHarness.sentPayloads),
    });

    expect(result.map((payload) => payload.content)).toContain("*🧠 planning the change*");
  });

  test("suppresses completed thinking messages when disabled for the channel", async () => {
    const harness = await makeHarness(false);
    const ack = await makeDeferred<void>();

    const result = await runWorkerScenario({
      harness,
      events: [
        {
          type: "reasoning-completed",
          partId: "reasoning-1",
          text: "planning the change",
        },
        finalizeEvent(ack),
      ],
      afterEvents: () => awaitAck(ack),
      collect: (currentHarness) => Effect.succeed(currentHarness.sentPayloads),
    });

    expect(result.map((payload) => payload.content)).not.toContain("*🧠 planning the change*");
  });

  test("uses updated channel settings during an active run", async () => {
    const harness = await makeHarness(true);
    const ack = await makeDeferred<void>();

    const result = await runWorkerScenario({
      harness,
      events: [makeReasoningCompletedEvent(1), finalizeEvent(ack)],
      beforeEvents: () =>
        Effect.sync(() => {
          harness.session.channelSettings = {
            ...harness.session.channelSettings,
            showThinking: false,
          };
        }),
      afterEvents: () => awaitAck(ack),
      collect: (currentHarness) => Effect.succeed(currentHarness.sentPayloads),
    });

    expect(result.map((payload) => payload.content)).not.toContain("*🧠 thinking 1*");
  });

  test("ignores later terminal updates once a tool call is already terminal", async () => {
    const harness = await makeHarness();
    const ack = await makeDeferred<void>();

    const result = await runWorkerScenario({
      harness,
      events: [
        {
          type: "tool-updated",
          part: makeToolPart("completed", {
            title: "Print cwd",
          }),
        },
        {
          type: "tool-updated",
          part: makeToolPart("error", {
            title: "This terminal update should be ignored",
          }),
        },
        finalizeEvent(ack),
      ],
      afterEvents: () => awaitAck(ack),
      collect: collectCards,
    });

    expect(result.sent.map(cardText)).toEqual([
      "**💻 ✅ `bash` Completed in 0.00s**\n`pwd`\nPrint cwd",
    ]);
    expect(result.edited.map(cardText)).toEqual([]);
  });
});
