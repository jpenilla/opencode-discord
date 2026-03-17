import { describe, expect, test } from "bun:test";
import type { Message, MessageCreateOptions, MessageEditOptions } from "discord.js";
import type { CompactionPart, ToolPart } from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Fiber, Queue, Ref } from "effect";

import { maxProgressBatchSize, runProgressWorker, takeProgressBatch } from "@/sessions/progress.ts";
import type { ChannelSession, RunProgressEvent } from "@/sessions/session.ts";
import { unsafeStub } from "../support/stub.ts";

const cardText = (payload: MessageCreateOptions | MessageEditOptions) =>
  String(
    (payload as { components?: Array<{ components?: Array<{ data?: { content?: string } }> }> })
      .components?.[0]?.components?.[0]?.data?.content ?? "",
  );

const makeHarness = async (showThinking = true) => {
  const sentPayloads = await Effect.runPromise(
    Ref.make<Array<MessageCreateOptions | MessageEditOptions>>([]),
  );
  const editedPayloads = await Effect.runPromise(
    Ref.make<Array<MessageCreateOptions | MessageEditOptions>>([]),
  );
  const nextMessageId = await Effect.runPromise(Ref.make(0));

  const makePostedMessage = (): Message =>
    unsafeStub<Message>({
      id: `card-${Effect.runSync(Ref.updateAndGet(nextMessageId, (count) => count + 1))}`,
      edit: (payload: MessageEditOptions): Promise<Message> =>
        Effect.runPromise(Ref.update(editedPayloads, (current) => [...current, payload])).then(() =>
          makePostedMessage(),
        ),
    });

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
    channel: unsafeStub({
      isSendable: () => true,
      send: (payload: MessageCreateOptions) =>
        Effect.runPromise(Ref.update(sentPayloads, (current) => [...current, payload])).then(() =>
          makePostedMessage(),
        ),
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

const runFinalizationScenario = async (reason: "interrupted") => {
  const harness = await makeHarness();

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<RunProgressEvent>();
        const worker = yield* Effect.forkChild(
          runProgressWorker(
            harness.session,
            harness.sourceMessage,
            "/home/opencode/workspace",
            queue,
          ),
        );

        const ack = yield* Deferred.make<void>();
        yield* Queue.offer(queue, {
          type: "tool-updated",
          part: makeToolPart("running"),
        });
        yield* Queue.offer(queue, {
          type: "session-compacting",
          part: makeCompactionPart(),
        });
        yield* Queue.offer(queue, {
          type: "run-finalizing",
          ack,
          reason,
        });
        yield* Deferred.await(ack);
        yield* Fiber.interrupt(worker);

        return {
          sent: yield* Ref.get(harness.sentPayloads),
          edited: yield* Ref.get(harness.editedPayloads),
        };
      }),
    ),
  );

  return result;
};

describe("takeProgressBatch", () => {
  test("blocks until the first event arrives and preserves queued overflow for the next drain", async () => {
    const queue = await Effect.runPromise(Queue.unbounded<RunProgressEvent>());
    const events = Array.from({ length: maxProgressBatchSize + 5 }, (_, index) =>
      makeReasoningCompletedEvent(index + 1),
    );

    const { firstBatch, secondBatch } = await Effect.runPromise(
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

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<RunProgressEvent>();
          const worker = yield* Effect.forkChild(
            runProgressWorker(
              harness.session,
              harness.sourceMessage,
              "/home/opencode/workspace",
              queue,
            ),
          );

          const ack = yield* Deferred.make<void>();
          yield* Queue.offer(queue, {
            type: "session-compacted",
            compacted: {
              sessionID: "session-1",
            },
          });
          yield* Queue.offer(queue, {
            type: "run-finalizing",
            ack,
          });
          yield* Deferred.await(ack);
          yield* Fiber.interrupt(worker);

          return {
            sent: yield* Ref.get(harness.sentPayloads),
            edited: yield* Ref.get(harness.editedPayloads),
          };
        }),
      ),
    );

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
      "**🛑 Compaction interrupted**\nOpenCode stopped compacting this session because the run was interrupted.",
    );
  });

  test("ignores a late session-compacted event after interrupted compaction finalization", async () => {
    const harness = await makeHarness();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<RunProgressEvent>();
          const worker = yield* Effect.forkChild(
            runProgressWorker(
              harness.session,
              harness.sourceMessage,
              "/home/opencode/workspace",
              queue,
            ),
          );

          const firstAck = yield* Deferred.make<void>();
          const secondAck = yield* Deferred.make<void>();
          yield* Queue.offer(queue, {
            type: "session-compacting",
            part: makeCompactionPart(),
          });
          yield* Queue.offer(queue, {
            type: "run-finalizing",
            ack: firstAck,
            reason: "interrupted",
          });
          yield* Deferred.await(firstAck);
          yield* Queue.offer(queue, {
            type: "session-compacted",
            compacted: {
              sessionID: "session-1",
            },
          });
          yield* Queue.offer(queue, {
            type: "run-finalizing",
            ack: secondAck,
          });
          yield* Deferred.await(secondAck);
          yield* Fiber.interrupt(worker);

          return {
            sent: yield* Ref.get(harness.sentPayloads),
            edited: yield* Ref.get(harness.editedPayloads),
          };
        }),
      ),
    );

    expect(result.sent.map(cardText)).toContain(
      "**🗜️ Compacting session**\nOpenCode is summarizing earlier context for this session.",
    );
    expect(result.edited.map(cardText)).toEqual([
      "**🛑 Compaction interrupted**\nOpenCode stopped compacting this session because the run was interrupted.",
    ]);
  });

  test("updates live tool and compaction cards to interrupted on finalization", async () => {
    const result = await runFinalizationScenario("interrupted");

    expect(result.edited.map(cardText)).toContain(
      "**💻 🛑 `bash` Interrupted**\n`pwd`\nPrint cwd\nNote: This tool did not complete because the run was interrupted.",
    );
    expect(result.edited.map(cardText)).toContain(
      "**🛑 Compaction interrupted**\nOpenCode stopped compacting this session because the run was interrupted.",
    );
  });

  test("sends completed thinking messages when enabled for the channel", async () => {
    const harness = await makeHarness(true);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<RunProgressEvent>();
          const worker = yield* Effect.forkChild(
            runProgressWorker(
              harness.session,
              harness.sourceMessage,
              "/home/opencode/workspace",
              queue,
            ),
          );

          const ack = yield* Deferred.make<void>();
          yield* Queue.offer(queue, {
            type: "reasoning-completed",
            partId: "reasoning-1",
            text: "planning the change",
          });
          yield* Queue.offer(queue, {
            type: "run-finalizing",
            ack,
          });
          yield* Deferred.await(ack);
          yield* Fiber.interrupt(worker);

          return yield* Ref.get(harness.sentPayloads);
        }),
      ),
    );

    expect(result.map((payload) => payload.content)).toContain("*🧠 planning the change*");
  });

  test("suppresses completed thinking messages when disabled for the channel", async () => {
    const harness = await makeHarness(false);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<RunProgressEvent>();
          const worker = yield* Effect.forkChild(
            runProgressWorker(
              harness.session,
              harness.sourceMessage,
              "/home/opencode/workspace",
              queue,
            ),
          );

          const ack = yield* Deferred.make<void>();
          yield* Queue.offer(queue, {
            type: "reasoning-completed",
            partId: "reasoning-1",
            text: "planning the change",
          });
          yield* Queue.offer(queue, {
            type: "run-finalizing",
            ack,
          });
          yield* Deferred.await(ack);
          yield* Fiber.interrupt(worker);

          return yield* Ref.get(harness.sentPayloads);
        }),
      ),
    );

    expect(result.map((payload) => payload.content)).not.toContain("*🧠 planning the change*");
  });

  test("ignores later terminal updates once a tool call is already terminal", async () => {
    const harness = await makeHarness();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<RunProgressEvent>();
          const worker = yield* Effect.forkChild(
            runProgressWorker(
              harness.session,
              harness.sourceMessage,
              "/home/opencode/workspace",
              queue,
            ),
          );

          const ack = yield* Deferred.make<void>();
          yield* Queue.offer(queue, {
            type: "tool-updated",
            part: makeToolPart("completed", {
              title: "Print cwd",
            }),
          });
          yield* Queue.offer(queue, {
            type: "tool-updated",
            part: makeToolPart("error", {
              title: "This terminal update should be ignored",
            }),
          });
          yield* Queue.offer(queue, {
            type: "run-finalizing",
            ack,
          });
          yield* Deferred.await(ack);
          yield* Fiber.interrupt(worker);

          return {
            sent: yield* Ref.get(harness.sentPayloads),
            edited: yield* Ref.get(harness.editedPayloads),
          };
        }),
      ),
    );

    expect(result.sent.map(cardText)).toEqual([
      "**💻 ✅ `bash` Completed in 0.00s**\n`pwd`\nPrint cwd",
    ]);
    expect(result.edited.map(cardText)).toEqual([]);
  });
});
