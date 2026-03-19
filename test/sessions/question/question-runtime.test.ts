import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import type { Message, MessageCreateOptions, MessageEditOptions } from "discord.js";
import type { QuestionRequest } from "@opencode-ai/sdk/v2";

import { makeQuestionRuntime } from "@/sessions/question/question-runtime.ts";
import { createPromptState } from "@/sessions/run/prompt-state.ts";
import { noQuestionOutcome, type ActiveRun, type ChannelSession } from "@/sessions/session.ts";
import { unsafeStub } from "../../support/stub.ts";

const makeRequest = (id = "req-1") =>
  unsafeStub<QuestionRequest>({
    id,
    questions: [
      {
        header: "Question",
        question: "Question?",
        options: [{ label: "Yes", description: "desc" }],
      },
    ],
  });

describe("makeQuestionRuntime", () => {
  test("shuts down open questions per session and ignores later question events", async () => {
    const promptState = await Effect.runPromise(createPromptState());
    const replyPayloads = await Effect.runPromise(Ref.make<unknown[]>([]));
    const editedPayloads = await Effect.runPromise(Ref.make<unknown[]>([]));
    const rejectCalls = await Effect.runPromise(Ref.make<string[]>([]));

    const questionMessage = unsafeStub<Message>({
      id: "question-message-1",
      edit: (payload: MessageEditOptions) =>
        Effect.runPromise(Ref.update(editedPayloads, (current) => [...current, payload])).then(
          () => questionMessage,
        ),
    });
    const originMessage = unsafeStub<Message>({
      id: "origin",
      channelId: "channel-1",
      reply: (payload: MessageCreateOptions) =>
        Effect.runPromise(Ref.update(replyPayloads, (current) => [...current, payload])).then(
          () => questionMessage,
        ),
    });

    const activeRun: ActiveRun = {
      originMessage,
      workdir: "/home/opencode/workspace",
      attachmentMessagesById: new Map(),
      currentPromptContext: null,
      previousPromptMessageIds: new Set<string>(),
      currentPromptMessageIds: new Set<string>(),
      currentPromptUserMessageId: null,
      assistantMessageParentIds: new Map<string, string>(),
      observedToolCallIds: new Set<string>(),
      progressQueue: {} as ActiveRun["progressQueue"],
      promptState,
      followUpQueue: {} as ActiveRun["followUpQueue"],
      acceptFollowUps: {} as ActiveRun["acceptFollowUps"],
      typing: {
        pause: async () => {},
        resume: () => {},
        stop: async () => {},
      },
      finalizeProgress: () => Effect.void,
      questionOutcome: noQuestionOutcome(),
      interruptRequested: false,
      interruptSource: null,
    };
    const session: ChannelSession = unsafeStub({
      channelId: "channel-1",
      opencode: {
        sessionId: "session-1",
        client: {} as never,
        workdir: "/home/opencode/workspace",
        backend: "bwrap",
        close: () => Effect.void,
      },
      rootDir: "/tmp/root",
      workdir: "/home/opencode/workspace",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      channelSettings: {
        showThinking: true,
        showCompactionSummaries: true,
      },
      progressChannel: null,
      progressMentionContext: null,
      emittedCompactionSummaryMessageIds: new Set<string>(),
      queue: {} as ChannelSession["queue"],
      activeRun,
    });

    const runtime = await Effect.runPromise(
      makeQuestionRuntime({
        getSessionContext: () => Effect.succeed({ session, activeRun }),
        replyToQuestion: () => Effect.void,
        rejectQuestion: (_session, requestId) =>
          Ref.update(rejectCalls, (current) => [...current, requestId]),
        sendQuestionUiFailure: () => Effect.void,
        logger: {
          info: () => Effect.void,
          warn: () => Effect.void,
          error: () => Effect.void,
        },
        formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
      }),
    );

    const firstResult = await Effect.runPromise(
      runtime.handleEvent({
        type: "asked",
        sessionId: session.opencode.sessionId,
        request: makeRequest(),
      }),
    );

    expect(firstResult).not.toBeNull();
    expect(await Effect.runPromise(runtime.hasPendingQuestionsAnywhere())).toBe(true);

    await Effect.runPromise(runtime.shutdownSession(session.opencode.sessionId));

    expect(await Effect.runPromise(Ref.get(rejectCalls))).toEqual(["req-1"]);
    expect(await Effect.runPromise(runtime.hasPendingQuestionsAnywhere())).toBe(false);
    expect(await Effect.runPromise(Ref.get(replyPayloads))).toHaveLength(1);
    expect(await Effect.runPromise(Ref.get(editedPayloads))).toHaveLength(1);
    expect(JSON.stringify((await Effect.runPromise(Ref.get(editedPayloads)))[0])).toContain(
      "Questions expired",
    );

    const lateResult = await Effect.runPromise(
      runtime.handleEvent({
        type: "asked",
        sessionId: session.opencode.sessionId,
        request: makeRequest("req-2"),
      }),
    );

    expect(lateResult).toBeNull();
    expect(await Effect.runPromise(Ref.get(rejectCalls))).toEqual(["req-1"]);
  });
});
