import { describe, expect, test } from "bun:test"
import type { Message } from "discord.js"

import { admitRequestBatchToActiveRun } from "@/sessions/run-batch.ts"
import type { RunRequest } from "@/sessions/session.ts"

const makeMessage = (id: string, attachmentCount = 0) =>
  ({
    id,
    attachments: new Map(
      Array.from({ length: attachmentCount }, (_, index) => [
        `att-${id}-${index}`,
        { id: `att-${id}-${index}` },
      ]),
    ),
  }) as unknown as Message

const makeRequest = (
  prompt: string,
  attachmentMessages: ReadonlyArray<Message>,
): RunRequest => ({
  message: attachmentMessages[0]!,
  prompt,
  attachmentMessages,
})

describe("admitRequestBatchToActiveRun", () => {
  test("returns the single initial prompt unchanged and tracks all known messages", () => {
    const current = new Map<string, Message>()
    const main = makeMessage("m-1")
    const referenced = makeMessage("m-2")

    const prompt = admitRequestBatchToActiveRun(
      current,
      [makeRequest("prompt one", [main, referenced])],
      "initial",
    )

    expect(prompt).toBe("prompt one")
    expect([...current.keys()]).toEqual(["m-1", "m-2"])
  })

  test("wraps multiple initial prompts in order", () => {
    const current = new Map<string, Message>()

    const prompt = admitRequestBatchToActiveRun(
      current,
      [
        makeRequest("first", [makeMessage("m-1")]),
        makeRequest("second", [makeMessage("m-2")]),
      ],
      "initial",
    )

    expect(prompt).toBe(
      [
        "Multiple Discord messages arrived before you responded. Read all of them and address them together in order.",
        "<discord-message index=\"1\">\nfirst\n</discord-message>",
        "<discord-message index=\"2\">\nsecond\n</discord-message>",
      ].join("\n\n"),
    )
  })

  test("wraps follow-up prompts and tracks newly introduced message ids", () => {
    const current = new Map<string, Message>([["m-1", makeMessage("m-1")]])
    const followUp = makeMessage("m-2")
    const referenced = makeMessage("m-3")

    const prompt = admitRequestBatchToActiveRun(
      current,
      [makeRequest("later", [followUp, referenced])],
      "follow-up",
    )

    expect(prompt).toBe(
      [
        "Additional Discord messages arrived while you were working. Read all of them, address them, and continue the task.",
        "<discord-message index=\"1\">\nlater\n</discord-message>",
      ].join("\n\n"),
    )
    expect([...current.keys()]).toEqual(["m-1", "m-2", "m-3"])
  })

  test("dedupes repeated message ids across batches", () => {
    const repeated = makeMessage("m-2")
    const current = new Map<string, Message>([["m-1", makeMessage("m-1")]])

    admitRequestBatchToActiveRun(
      current,
      [
        makeRequest("later", [repeated]),
        makeRequest("later again", [repeated]),
      ],
      "follow-up",
    )

    expect([...current.keys()]).toEqual(["m-1", "m-2"])
  })

  test("tracks referenced messages even when they have no attachments", () => {
    const current = new Map<string, Message>()
    const main = makeMessage("m-1", 1)
    const referenced = makeMessage("m-2", 0)

    admitRequestBatchToActiveRun(
      current,
      [makeRequest("prompt", [main, referenced])],
      "initial",
    )

    expect(current.get("m-2")).toBe(referenced)
    expect(current.get("m-2")?.attachments.size).toBe(0)
  })
})
