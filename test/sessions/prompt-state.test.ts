import { describe, expect, test } from "bun:test";
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Option, Ref } from "effect";

import {
  beginPendingPrompt,
  createPromptState,
  handleAssistantMessageUpdated,
  handleUserMessageUpdated,
} from "@/sessions/prompt-state.ts";
import { unsafeStub } from "../support/stub.ts";

const makeAssistantMessage = (input: {
  id: string;
  parentId: string;
  summary?: boolean;
  mode?: string;
  completed?: boolean;
  finish?: AssistantMessage["finish"];
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
    finish: input.finish,
    time: input.completed
      ? {
          created: 1,
          completed: 2,
        }
      : {
          created: 1,
        },
  });

const makeUserMessage = (id: string): UserMessage =>
  unsafeStub<UserMessage>({
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
  });

describe("prompt-state", () => {
  test("ignores auto-compaction summaries parented to the original user message", async () => {
    const state = await Effect.runPromise(createPromptState());
    const completion = await Effect.runPromise(beginPendingPrompt(state));
    await Effect.runPromise(handleUserMessageUpdated(state, makeUserMessage("user-1")));

    const summaryActions = await Effect.runPromise(
      handleAssistantMessageUpdated(
        state,
        makeAssistantMessage({
          id: "summary-1",
          parentId: "user-1",
          summary: true,
          mode: "compaction",
          completed: true,
        }),
      ),
    );

    expect(summaryActions).toEqual([]);
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);
    expect(await Effect.runPromise(Ref.get(state))).not.toBeNull();

    await Effect.runPromise(handleUserMessageUpdated(state, makeUserMessage("user-2")));
    const finalActions = await Effect.runPromise(
      handleAssistantMessageUpdated(
        state,
        makeAssistantMessage({
          id: "assistant-1",
          parentId: "user-2",
          completed: true,
        }),
      ),
    );

    expect(finalActions).toHaveLength(1);
    const action = finalActions[0];
    expect(action?.type).toBe("complete-prompt");
    if (!action || action.type !== "complete-prompt") {
      throw new Error("expected a completion action");
    }
    expect(action.messageId).toBe("assistant-1");
  });

  test("waits for the follow-up assistant after a tool-calls turn", async () => {
    const state = await Effect.runPromise(createPromptState());
    const completion = await Effect.runPromise(beginPendingPrompt(state));

    await Effect.runPromise(handleUserMessageUpdated(state, makeUserMessage("user-1")));

    expect(
      await Effect.runPromise(
        handleAssistantMessageUpdated(
          state,
          makeAssistantMessage({
            id: "assistant-1",
            parentId: "user-1",
            completed: true,
            finish: "tool-calls",
          }),
        ),
      ),
    ).toEqual([]);
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);

    const actions = await Effect.runPromise(
      handleAssistantMessageUpdated(
        state,
        makeAssistantMessage({
          id: "assistant-2",
          parentId: "user-1",
          completed: true,
          finish: "stop",
        }),
      ),
    );

    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.type).toBe("complete-prompt");
    if (!action || action.type !== "complete-prompt") {
      throw new Error("expected a completion action");
    }
    expect(action.messageId).toBe("assistant-2");
    expect(await Effect.runPromise(Ref.get(state))).toBeNull();
  });

  test("waits to bind the server-created user message before completing the prompt", async () => {
    const state = await Effect.runPromise(createPromptState());
    const completion = await Effect.runPromise(beginPendingPrompt(state));

    await Effect.runPromise(
      handleAssistantMessageUpdated(
        state,
        makeAssistantMessage({
          id: "assistant-1",
          parentId: "user-1",
          completed: true,
        }),
      ),
    );

    expect(Option.isNone(await Effect.runPromise(Deferred.poll(completion)))).toBe(true);

    const actions = await Effect.runPromise(
      handleUserMessageUpdated(state, makeUserMessage("user-1")),
    );

    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.type).toBe("complete-prompt");
    if (!action || action.type !== "complete-prompt") {
      throw new Error("expected a completion action");
    }
    expect(action.messageId).toBe("assistant-1");
  });
});
