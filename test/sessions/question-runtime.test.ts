import { describe, expect, test } from "bun:test";
import type { Interaction, Message, MessageCreateOptions, MessageEditOptions } from "discord.js";
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Ref } from "effect";

import { createQuestionRuntime } from "@/sessions/question-runtime.ts";
import { createPromptState } from "@/sessions/prompt-state.ts";
import { noQuestionOutcome, type ActiveRun, type ChannelSession } from "@/sessions/session.ts";
import { unsafeStub } from "../support/stub.ts";

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

const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref));

const makeHarness = async (options?: {
  postQuestionResult?: "success" | "failure";
  rejectResult?: "success" | "failure";
  blockQuestionPost?: boolean;
}) => {
  const postedPayloads = await Effect.runPromise(Ref.make<MessageCreateOptions[]>([]));
  const editedPayloads = await Effect.runPromise(Ref.make<MessageEditOptions[]>([]));
  const interactionReplies = await Effect.runPromise(
    Ref.make<Array<{ content?: string | null }>>([]),
  );
  const sentQuestionUiFailures = await Effect.runPromise(Ref.make<string[]>([]));
  const replyCalls = await Effect.runPromise(Ref.make<string[]>([]));
  const rejectCalls = await Effect.runPromise(Ref.make<string[]>([]));
  const typingPauseCount = await Effect.runPromise(Ref.make(0));
  const typingResumeCount = await Effect.runPromise(Ref.make(0));
  const typingStopCount = await Effect.runPromise(Ref.make(0));
  const promptState = await Effect.runPromise(createPromptState());
  const questionPostStarted = await Effect.runPromise(Deferred.make<void>());
  const allowQuestionPost = await Effect.runPromise(Deferred.make<void>());

  const questionMessage: Message = unsafeStub<Message>({
    id: "question-message",
    edit: (payload: MessageEditOptions): Promise<Message> =>
      Effect.runPromise(Ref.update(editedPayloads, (current) => [...current, payload])).then(
        () => questionMessage,
      ),
  });

  const discordMessage = unsafeStub<Message>({
    id: "discord-message",
    channelId: "channel-1",
    author: { id: "owner", tag: "owner#0001" },
    reply: (payload: MessageCreateOptions) =>
      Effect.runPromise(Ref.update(postedPayloads, (current) => [...current, payload])).then(
        async () => {
          if (options?.blockQuestionPost) {
            await Effect.runPromise(
              Deferred.succeed(questionPostStarted, undefined).pipe(Effect.ignore),
            );
            await Effect.runPromise(Deferred.await(allowQuestionPost));
          }
          if (options?.postQuestionResult === "failure") {
            throw new Error("post failed");
          }
          return questionMessage;
        },
      ),
  });

  const activeRun: ActiveRun = {
    discordMessage,
    workdir: "/home/opencode/workspace",
    attachmentMessagesById: new Map(),
    progressQueue: {} as ActiveRun["progressQueue"],
    promptState,
    followUpQueue: {} as ActiveRun["followUpQueue"],
    acceptFollowUps: {} as ActiveRun["acceptFollowUps"],
    typing: {
      pause: () => Effect.runPromise(Ref.update(typingPauseCount, (count) => count + 1)),
      resume: () => {
        void Effect.runPromise(Ref.update(typingResumeCount, (count) => count + 1));
      },
      stop: () => Effect.runPromise(Ref.update(typingStopCount, (count) => count + 1)),
    },
    finalizeProgress: () => Effect.void,
    questionOutcome: noQuestionOutcome(),
    interruptRequested: false,
  };

  const session: ChannelSession = {
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
  };
  session.activeRun = activeRun;

  const runtime = await Effect.runPromise(
    createQuestionRuntime({
      getSessionContext: (sessionId) =>
        Effect.succeed(sessionId === session.opencode.sessionId ? { session, activeRun } : null),
      replyToQuestion: (_opencode, requestId, _answers) =>
        Ref.update(replyCalls, (current) => [...current, requestId]),
      rejectQuestion: (_opencode, requestId) =>
        Ref.update(rejectCalls, (current) => [...current, requestId]).pipe(
          Effect.flatMap(() =>
            options?.rejectResult === "failure"
              ? Effect.fail(new Error("reject failed"))
              : Effect.void,
          ),
        ),
      sendQuestionUiFailure: (_message, error) =>
        Ref.update(sentQuestionUiFailures, (current) => [...current, String(error)]),
      logger: {
        info: () => Effect.void,
        warn: () => Effect.void,
        error: () => Effect.void,
      },
      formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    }),
  );

  const makeButtonInteraction = (input: {
    customId: string;
    userId?: string;
    messageId?: string;
  }) =>
    unsafeStub<Interaction>({
      customId: input.customId,
      user: { id: input.userId ?? "owner" },
      message: { id: input.messageId ?? questionMessage.id },
      replied: false,
      deferred: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      reply: (payload: { content?: string | null }) =>
        Effect.runPromise(Ref.update(interactionReplies, (current) => [...current, payload])),
      update: (_payload: MessageEditOptions) => Promise.resolve(questionMessage),
      followUp: (_payload: unknown) => Promise.resolve(questionMessage),
      showModal: (_modal: unknown) => Promise.resolve(),
      deferUpdate: () => Promise.resolve(),
    });

  const makeSelectInteraction = (input: {
    customId: string;
    values: string[];
    userId?: string;
    messageId?: string;
  }) =>
    unsafeStub<Interaction>({
      customId: input.customId,
      values: input.values,
      user: { id: input.userId ?? "owner" },
      message: { id: input.messageId ?? questionMessage.id },
      replied: false,
      deferred: false,
      isButton: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      reply: (payload: { content?: string | null }) =>
        Effect.runPromise(Ref.update(interactionReplies, (current) => [...current, payload])),
      update: (_payload: MessageEditOptions) => Promise.resolve(questionMessage),
      followUp: (_payload: unknown) => Promise.resolve(questionMessage),
      showModal: (_modal: unknown) => Promise.resolve(),
      deferUpdate: () => Promise.resolve(),
    });

  const makeModalInteraction = (input: { customId: string; value: string; userId?: string }) =>
    unsafeStub<Interaction>({
      customId: input.customId,
      user: { id: input.userId ?? "owner" },
      replied: false,
      deferred: false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isChatInputCommand: () => false,
      reply: (payload: { content?: string | null }) =>
        Effect.runPromise(Ref.update(interactionReplies, (current) => [...current, payload])),
      update: (_payload: MessageEditOptions) => Promise.resolve(questionMessage),
      followUp: (_payload: unknown) => Promise.resolve(questionMessage),
      showModal: (_modal: unknown) => Promise.resolve(),
      deferUpdate: () => Promise.resolve(),
      fields: {
        getTextInputValue: () => input.value,
      },
    });

  return {
    runtime,
    session,
    activeRun,
    questionMessage,
    request: makeRequest(),
    postedPayloads,
    editedPayloads,
    interactionReplies,
    sentQuestionUiFailures,
    replyCalls,
    rejectCalls,
    typingPauseCount,
    typingResumeCount,
    typingStopCount,
    questionPostStarted,
    allowQuestionPost,
    makeButtonInteraction,
    makeSelectInteraction,
    makeModalInteraction,
  };
};

describe("createQuestionRuntime", () => {
  test("posts a question batch once and resumes typing after a reply event", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );
    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    expect((await getRef(harness.postedPayloads)).length).toBe(1);
    expect(await getRef(harness.typingPauseCount)).toBe(1);

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "replied",
        sessionId: harness.session.opencode.sessionId,
        requestId: harness.request.id,
        answers: [["Yes"]] satisfies ReadonlyArray<QuestionAnswer>,
      }),
    );

    expect((await getRef(harness.editedPayloads)).length).toBe(1);
    expect(await getRef(harness.typingResumeCount)).toBe(1);
  });

  test("sends a UI failure reply when posting the question and rejecting it both fail", async () => {
    const harness = await makeHarness({
      postQuestionResult: "failure",
      rejectResult: "failure",
    });

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    expect(await getRef(harness.rejectCalls)).toEqual([harness.request.id]);
    expect(await getRef(harness.sentQuestionUiFailures)).toEqual(["post failed"]);
    expect(await getRef(harness.typingStopCount)).toBe(1);
    expect(harness.activeRun.questionOutcome).toEqual({
      _tag: "ui-failure",
      message: "post failed",
      notified: true,
    });
  });

  test("allows question interactions from other users", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    const handled = await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: `ocq:${harness.request.id}:0:submit`,
          userId: "intruder",
        }),
      ),
    );

    expect(handled).toBe(true);
    expect(await getRef(harness.interactionReplies)).toEqual([]);
    expect(await getRef(harness.replyCalls)).toEqual([harness.request.id]);
  });

  test("expires question batches for a session and treats later interactions as expired", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    await Effect.runPromise(
      harness.runtime.terminateForSession(harness.session.opencode.sessionId),
    );

    const handled = await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: `ocq:${harness.request.id}:0:submit`,
        }),
      ),
    );

    expect(handled).toBe(true);
    expect((await getRef(harness.editedPayloads)).length).toBe(1);
    expect((await getRef(harness.interactionReplies))[0]?.content).toBe(
      "This question prompt has expired.",
    );
  });

  test("shows a late question card and clears interruptRequested once the question wins the race", async () => {
    const harness = await makeHarness();
    harness.activeRun.interruptRequested = true;

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    expect(harness.activeRun.interruptRequested).toBe(false);
    expect(await getRef(harness.rejectCalls)).toEqual([]);
    expect(await getRef(harness.postedPayloads)).toHaveLength(1);
    expect(await getRef(harness.editedPayloads)).toHaveLength(0);
  });

  test("expires a question batch even when shutdown lands while the Discord card post is in flight", async () => {
    const harness = await makeHarness({
      blockQuestionPost: true,
    });

    const asked = Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    await Effect.runPromise(Deferred.await(harness.questionPostStarted));
    await Effect.runPromise(
      harness.runtime.terminateForSession(harness.session.opencode.sessionId),
    );
    await Effect.runPromise(
      Deferred.succeed(harness.allowQuestionPost, undefined).pipe(Effect.ignore),
    );
    await asked;

    const edits = await getRef(harness.editedPayloads);
    expect(edits).toHaveLength(1);
    expect(JSON.stringify(edits[0])).toContain("Questions expired");
    expect(JSON.stringify(edits[0])).toContain(
      "This question prompt expired before it was answered.",
    );
  });

  test("ignores new question cards after shutdown begins", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(harness.runtime.shutdown());
    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    expect(await getRef(harness.postedPayloads)).toHaveLength(0);
  });

  test("finalizes a late-posted question card when a reply event wins the race", async () => {
    const harness = await makeHarness({
      blockQuestionPost: true,
    });

    const asked = Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    await Effect.runPromise(Deferred.await(harness.questionPostStarted));
    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "replied",
        sessionId: harness.session.opencode.sessionId,
        requestId: harness.request.id,
        answers: [["Yes"]] satisfies ReadonlyArray<QuestionAnswer>,
      }),
    );
    await Effect.runPromise(
      Deferred.succeed(harness.allowQuestionPost, undefined).pipe(Effect.ignore),
    );
    await asked;

    const edits = await getRef(harness.editedPayloads);
    expect(edits).toHaveLength(1);
    expect(JSON.stringify(edits[0])).toContain("✅ Questions answered");
  });

  test("replies with a stale-state error after a newer page action wins", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: `ocq:${harness.request.id}:0:question-next`,
        }),
      ),
    );

    const handled = await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: `ocq:${harness.request.id}:0:question-prev`,
          userId: "intruder",
        }),
      ),
    );

    expect(handled).toBe(true);
    expect((await getRef(harness.interactionReplies)).at(-1)?.content).toBe(
      "Another user updated this question prompt before your action was applied. Review the latest card and try again.",
    );
  });

  test("replies with a stale-state error for modal submissions from an old version", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.handleEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeSelectInteraction({
          customId: `ocq:${harness.request.id}:0:select:0`,
          values: ["Yes"],
        }),
      ),
    );

    const handled = await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeModalInteraction({
          customId: `ocq:${harness.request.id}:0:modal:0`,
          value: "Other",
          userId: "intruder",
        }),
      ),
    );

    expect(handled).toBe(true);
    expect((await getRef(harness.interactionReplies)).at(-1)?.content).toBe(
      "Another user updated this question prompt before your action was applied. Review the latest card and try again.",
    );
  });
});
