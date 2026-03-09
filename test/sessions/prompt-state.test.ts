import { describe, expect, test } from "bun:test"
import type { AssistantMessage, ToolPart } from "@opencode-ai/sdk/v2"
import { Deferred, Effect, Option, Ref } from "effect"

import {
  beginPendingPrompt,
  createPromptState,
  handleAssistantMessageUpdated,
  handleToolPartUpdated,
} from "@/sessions/prompt-state.ts"
import { unsafeStub } from "../support/stub.ts"

const makeAssistantMessage = (input: {
  id: string
  parentId: string
  summary?: boolean
  mode?: string
  completed?: boolean
}): AssistantMessage =>
  unsafeStub<AssistantMessage>({
    id: input.id,
    sessionID: "session-1",
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
    time: input.completed
      ? {
          created: 1,
          completed: 2,
        }
      : {
          created: 1,
        },
  })

const makeToolPart = (status: "running" | "error"): ToolPart =>
  unsafeStub<ToolPart>({
    id: `part-${status}`,
    sessionID: "session-1",
    messageID: "assistant-1",
    type: "tool",
    callID: "call-1",
    tool: "bash",
    state: status === "running"
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
  })

describe("prompt-state", () => {
  test("emits a compaction summary once and keeps waiting for the direct reply", async () => {
    const state = await Effect.runPromise(createPromptState())
    await Effect.runPromise(beginPendingPrompt(state, "user-1"))

    const first = await Effect.runPromise(handleAssistantMessageUpdated(state, makeAssistantMessage({
      id: "summary-1",
      parentId: "synthetic-1",
      summary: true,
      mode: "compaction",
      completed: true,
    })))
    const second = await Effect.runPromise(handleAssistantMessageUpdated(state, makeAssistantMessage({
      id: "summary-1",
      parentId: "synthetic-1",
      summary: true,
      mode: "compaction",
      completed: true,
    })))

    expect(first).toEqual([{
      type: "emit-compaction-summary",
      messageId: "summary-1",
    }])
    expect(second).toEqual([])
    expect(await Effect.runPromise(Ref.get(state))).not.toBeNull()
  })

  test("does not complete the prompt until the live tool settles", async () => {
    const state = await Effect.runPromise(createPromptState())
    const completion = await Effect.runPromise(beginPendingPrompt(state, "user-1"))

    expect(await Effect.runPromise(handleToolPartUpdated(state, makeToolPart("running")))).toEqual([])
    expect(await Effect.runPromise(handleAssistantMessageUpdated(state, makeAssistantMessage({
      id: "assistant-1",
      parentId: "user-1",
      completed: true,
    })))).toEqual([])
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true)

    const actions = await Effect.runPromise(handleToolPartUpdated(state, makeToolPart("error")))

    expect(actions).toHaveLength(1)
    const action = actions[0]
    expect(action?.type).toBe("complete-prompt")
    if (!action || action.type !== "complete-prompt") {
      throw new Error("expected a completion action")
    }
    expect(action.messageId).toBe("assistant-1")
    expect(await Effect.runPromise(Ref.get(state))).toBeNull()
  })
})
