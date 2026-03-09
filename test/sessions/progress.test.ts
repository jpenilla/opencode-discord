import { describe, expect, test } from "bun:test"
import type { Message, MessageCreateOptions, MessageEditOptions } from "discord.js"
import type { CompactionPart, ToolPart } from "@opencode-ai/sdk/v2"
import { Deferred, Effect, Fiber, Queue, Ref } from "effect"

import { runProgressWorker } from "@/sessions/progress.ts"
import type { RunProgressEvent } from "@/sessions/session.ts"
import { unsafeStub } from "../support/stub.ts"

const cardText = (payload: MessageCreateOptions | MessageEditOptions) =>
  String((payload as { components?: Array<{ components?: Array<{ data?: { content?: string } }> }> })
    .components?.[0]?.components?.[0]?.data?.content ?? "")

const makeHarness = async () => {
  const sentPayloads = await Effect.runPromise(Ref.make<Array<MessageCreateOptions | MessageEditOptions>>([]))
  const editedPayloads = await Effect.runPromise(Ref.make<Array<MessageCreateOptions | MessageEditOptions>>([]))
  const nextMessageId = await Effect.runPromise(Ref.make(0))

  const makePostedMessage = (): Message =>
    unsafeStub<Message>({
      id: `card-${Effect.runSync(Ref.updateAndGet(nextMessageId, (count) => count + 1))}`,
      edit: (payload: MessageEditOptions): Promise<Message> =>
        Effect.runPromise(Ref.update(editedPayloads, (current) => [...current, payload])).then(() => makePostedMessage()),
    })

  const sourceMessage = unsafeStub<Message>({
    id: "source-message",
    channel: unsafeStub({
      isSendable: () => true,
      send: (payload: MessageCreateOptions) =>
        Effect.runPromise(Ref.update(sentPayloads, (current) => [...current, payload])).then(() => makePostedMessage()),
    }),
  })

  return {
    sourceMessage,
    sentPayloads,
    editedPayloads,
  }
}

const makeRunningToolPart = (): ToolPart =>
  unsafeStub<ToolPart>({
    id: "part-1",
    sessionID: "session-1",
    messageID: "assistant-1",
    callID: "call-1",
    tool: "bash",
    state: {
      status: "running",
      input: {
        command: "pwd",
      },
      title: "Print cwd",
      time: {
        start: 1,
      },
    },
  })

const makeCompactionPart = (): CompactionPart =>
  unsafeStub<CompactionPart>({
    id: "compaction-1",
    sessionID: "session-1",
    messageID: "assistant-1",
    type: "compaction",
    auto: false,
  })

const runFinalizationScenario = async (reason: "interrupted" | "shutdown") => {
  const harness = await makeHarness()

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<RunProgressEvent>()
        const worker = yield* Effect.fork(
          runProgressWorker(harness.sourceMessage, "/home/opencode/workspace", queue),
        )

        const ack = yield* Deferred.make<void>()
        yield* Queue.offer(queue, {
          type: "tool-updated",
          part: makeRunningToolPart(),
        })
        yield* Queue.offer(queue, {
          type: "session-compacting",
          part: makeCompactionPart(),
        })
        yield* Queue.offer(queue, {
          type: "run-finalizing",
          ack,
          reason,
        })
        yield* Deferred.await(ack)
        yield* Fiber.interrupt(worker)

        return {
          sent: yield* Ref.get(harness.sentPayloads),
          edited: yield* Ref.get(harness.editedPayloads),
        }
      }),
    ),
  )

  return result
}

describe("runProgressWorker", () => {
  test("ignores session-compacted without an active compaction in this worker", async () => {
    const harness = await makeHarness()

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<RunProgressEvent>()
          const worker = yield* Effect.fork(
            runProgressWorker(harness.sourceMessage, "/home/opencode/workspace", queue),
          )

          const ack = yield* Deferred.make<void>()
          yield* Queue.offer(queue, {
            type: "session-compacted",
            compacted: {
              sessionID: "session-1",
            },
          })
          yield* Queue.offer(queue, {
            type: "run-finalizing",
            ack,
          })
          yield* Deferred.await(ack)
          yield* Fiber.interrupt(worker)

          return {
            sent: yield* Ref.get(harness.sentPayloads),
            edited: yield* Ref.get(harness.editedPayloads),
          }
        }),
      ),
    )

    expect(result.sent.map(cardText)).toEqual([])
    expect(result.edited.map(cardText)).toEqual([])
  })

  test("updates the live compaction card to interrupted", async () => {
    const result = await runFinalizationScenario("interrupted")

    expect(result.sent.map(cardText)).toContain("**💻 🛠️ `bash` Running**\n- Command: `pwd`\n- Purpose: Print cwd")
    expect(result.sent.map(cardText)).toContain("**🗜️ Compacting session**\nOpenCode is summarizing earlier context for this session.")
    expect(result.edited.map(cardText)).toContain(
      "**‼️ Compaction interrupted**\nOpenCode stopped compacting this session because the run was interrupted.",
    )
  })

  test("ignores a late session-compacted event after interrupted compaction finalization", async () => {
    const harness = await makeHarness()

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<RunProgressEvent>()
          const worker = yield* Effect.fork(
            runProgressWorker(harness.sourceMessage, "/home/opencode/workspace", queue),
          )

          const firstAck = yield* Deferred.make<void>()
          const secondAck = yield* Deferred.make<void>()
          yield* Queue.offer(queue, {
            type: "session-compacting",
            part: makeCompactionPart(),
          })
          yield* Queue.offer(queue, {
            type: "run-finalizing",
            ack: firstAck,
            reason: "interrupted",
          })
          yield* Deferred.await(firstAck)
          yield* Queue.offer(queue, {
            type: "session-compacted",
            compacted: {
              sessionID: "session-1",
            },
          })
          yield* Queue.offer(queue, {
            type: "run-finalizing",
            ack: secondAck,
          })
          yield* Deferred.await(secondAck)
          yield* Fiber.interrupt(worker)

          return {
            sent: yield* Ref.get(harness.sentPayloads),
            edited: yield* Ref.get(harness.editedPayloads),
          }
        }),
      ),
    )

    expect(result.sent.map(cardText)).toContain("**🗜️ Compacting session**\nOpenCode is summarizing earlier context for this session.")
    expect(result.edited.map(cardText)).toEqual([
      "**‼️ Compaction interrupted**\nOpenCode stopped compacting this session because the run was interrupted.",
    ])
  })

  test("updates live tool and compaction cards to stopped on shutdown", async () => {
    const result = await runFinalizationScenario("shutdown")

    expect(result.edited.map(cardText)).toContain(
      "**💻 🛑 `bash` Stopped**\n- Command: `pwd`\n- Purpose: Print cwd\n- Note: This tool did not complete because the bot shut down.",
    )
    expect(result.edited.map(cardText)).toContain(
      "**🛑 Compaction stopped**\nOpenCode stopped compacting this session because the bot shut down.",
    )
  })
})
