import { describe, expect, test } from "bun:test";
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";
import type { Interaction, Message, MessageCreateOptions, MessageEditOptions } from "discord.js";
import { Deferred, Effect, Ref } from "effect";

import {
  applyQuestionSignals,
  questionTypingAction,
  runQuestionTypingAction,
  type QuestionWorkflowSignal,
} from "@/sessions/question/question-run-state.ts";
import { makeQuestionRuntime } from "@/sessions/question/question-runtime.ts";
import { createPromptState } from "@/sessions/run/prompt-state.ts";
import { noQuestionOutcome, type ActiveRun, type ChannelSession } from "@/sessions/session.ts";
import { formatError } from "@/util/errors.ts";
import {
  getRef,
  makeMessage,
  makeSessionHandle,
  makeSilentLogger,
} from "../../support/fixtures.ts";
import { failTest } from "../../support/errors.ts";
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

const makeHarness = async (options?: {
  postQuestionResult?: "success" | "failure";
  rejectResult?: "success" | "failure";
  blockQuestionPost?: boolean;
  replyTargetId?: string;
}) => {
  const postedPayloads = await Effect.runPromise(Ref.make<MessageCreateOptions[]>([]));
  const editedPayloads = await Effect.runPromise(Ref.make<MessageEditOptions[]>([]));
  const interactionReplies = await Effect.runPromise(
    Ref.make<Array<{ content?: string | null }>>([]),
  );
  const sentQuestionUiFailures = await Effect.runPromise(Ref.make<string[]>([]));
  const questionReplyTargetIds = await Effect.runPromise(Ref.make<string[]>([]));
  const questionUiFailureTargetIds = await Effect.runPromise(Ref.make<string[]>([]));
  const replyCalls = await Effect.runPromise(Ref.make<string[]>([]));
  const rejectCalls = await Effect.runPromise(Ref.make<string[]>([]));
  const typingPauseCount = await Effect.runPromise(Ref.make(0));
  const typingResumeCount = await Effect.runPromise(Ref.make(0));
  const typingStopCount = await Effect.runPromise(Ref.make(0));
  const typingPausedRef = await Effect.runPromise(Ref.make(false));
  const promptState = await Effect.runPromise(createPromptState());
  const questionPostStarted = await Effect.runPromise(Deferred.make<void>());
  const allowQuestionPost = await Effect.runPromise(Deferred.make<void>());

  const questionMessage: Message = makeMessage({
    id: "question-message",
    edit: (payload: MessageEditOptions): Promise<Message> =>
      Effect.runPromise(Ref.update(editedPayloads, (current) => [...current, payload])).then(
        () => questionMessage,
      ),
  });

  const makeReplyTargetMessage = (id: string) =>
    makeMessage({
      id,
      channelId: "channel-1",
      author: { id: "owner", tag: "owner#0001" },
      reply: (payload: MessageCreateOptions) =>
        Effect.runPromise(Ref.update(questionReplyTargetIds, (current) => [...current, id])).then(
          () =>
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
        ),
    });

  const originMessage = makeReplyTargetMessage("origin-message");
  const replyTargetMessage =
    options?.replyTargetId && options.replyTargetId !== originMessage.id
      ? makeReplyTargetMessage(options.replyTargetId)
      : originMessage;

  const activeRun: ActiveRun = {
    originMessage,
    workdir: "/home/opencode/workspace",
    attachmentMessagesById: new Map(),
    currentPromptContext: {
      kind: replyTargetMessage.id === originMessage.id ? "initial" : "follow-up",
      prompt: "prompt",
      replyTargetMessage,
      requestMessages: [replyTargetMessage],
    },
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
      pause: () => Effect.runPromise(Ref.update(typingPauseCount, (count) => count + 1)),
      resume: () => {
        void Effect.runPromise(Ref.update(typingResumeCount, (count) => count + 1));
      },
      stop: () => Effect.runPromise(Ref.update(typingStopCount, (count) => count + 1)),
    },
    finalizeProgress: () => Effect.void,
    questionOutcome: noQuestionOutcome(),
    interruptRequested: false,
    interruptSource: null,
  };

  const session: ChannelSession = {
    channelId: "channel-1",
    opencode: makeSessionHandle(),
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
  const sessionContextRef = await Effect.runPromise(
    Ref.make<{ session: ChannelSession; activeRun: ActiveRun } | null>({ session, activeRun }),
  );

  const rawRuntime = await Effect.runPromise(
    makeQuestionRuntime({
      getSessionContext: () => Ref.get(sessionContextRef),
      replyToQuestion: (_opencode, requestId) =>
        Ref.update(replyCalls, (current) => [...current, requestId]),
      rejectQuestion: (_opencode, requestId) =>
        Ref.update(rejectCalls, (current) => [...current, requestId]).pipe(
          Effect.flatMap(() =>
            options?.rejectResult === "failure" ? failTest("reject failed") : Effect.void,
          ),
        ),
      sendQuestionUiFailure: (message, error) =>
        Ref.update(questionUiFailureTargetIds, (current) => [...current, message.id]).pipe(
          Effect.andThen(
            Ref.update(sentQuestionUiFailures, (current) => [...current, String(error)]),
          ),
        ),
      logger: makeSilentLogger(),
      formatError,
    }),
  );

  const reconcileTyping = () =>
    rawRuntime.hasPendingQuestions(session.opencode.sessionId).pipe(
      Effect.flatMap((pending) =>
        Ref.modify(typingPausedRef, (paused) => [{ paused, pending } as const, pending]).pipe(
          Effect.flatMap(({ paused }) =>
            runQuestionTypingAction({
              sessionId: session.opencode.sessionId,
              activeRun,
              action: questionTypingAction(activeRun, pending, paused),
              logger: { warn: () => Effect.void },
            }),
          ),
        ),
      ),
    );

  const applySignalsAndTyping = (signals: ReadonlyArray<QuestionWorkflowSignal>) =>
    applyQuestionSignals(activeRun, signals).pipe(Effect.andThen(reconcileTyping()));

  const handleRouted = <A extends { signals: ReadonlyArray<QuestionWorkflowSignal> } | null>(
    effect: Effect.Effect<A, unknown>,
  ) =>
    effect.pipe(
      Effect.tap((result) => (result ? applySignalsAndTyping(result.signals) : Effect.void)),
    );

  const runtime = {
    rawRuntime,
    handleEvent: rawRuntime.handleEvent,
    routeEvent: (event: Parameters<typeof rawRuntime.handleEvent>[0]) =>
      handleRouted(rawRuntime.handleEvent(event)),
    handleInteraction: (interaction: Interaction) =>
      handleRouted(rawRuntime.routeInteraction(interaction)),
    terminateForSession: (sessionId: string) =>
      rawRuntime.terminateSession(sessionId).pipe(Effect.tap(applySignalsAndTyping)),
    shutdown: () => rawRuntime.shutdownSession(session.opencode.sessionId),
  };

  const makeInteraction = (
    kind: "button" | "select" | "modal",
    input: {
      customId: string;
      userId?: string;
      messageId?: string;
      values?: string[];
      value?: string;
    },
  ) =>
    unsafeStub<Interaction>({
      customId: input.customId,
      values: input.values,
      user: { id: input.userId ?? "owner" },
      message: { id: input.messageId ?? questionMessage.id },
      replied: false,
      deferred: false,
      isButton: () => kind === "button",
      isStringSelectMenu: () => kind === "select",
      isModalSubmit: () => kind === "modal",
      isChatInputCommand: () => false,
      reply: (payload: { content?: string | null }) =>
        Effect.runPromise(Ref.update(interactionReplies, (current) => [...current, payload])),
      update: () => Promise.resolve(questionMessage),
      followUp: () => Promise.resolve(questionMessage),
      showModal: () => Promise.resolve(),
      deferUpdate: () => Promise.resolve(),
      fields: {
        getTextInputValue: () => input.value ?? "",
      },
    });

  return {
    runtime,
    session,
    sessionContextRef,
    activeRun,
    request: makeRequest(),
    postedPayloads,
    editedPayloads,
    interactionReplies,
    sentQuestionUiFailures,
    questionReplyTargetIds,
    questionUiFailureTargetIds,
    replyCalls,
    rejectCalls,
    typingPauseCount,
    typingResumeCount,
    typingStopCount,
    makeButtonInteraction: (input: { customId: string; userId?: string; messageId?: string }) =>
      makeInteraction("button", input),
    makeSelectInteraction: (input: {
      customId: string;
      values: string[];
      userId?: string;
      messageId?: string;
    }) => makeInteraction("select", input),
    makeModalInteraction: (input: { customId: string; value: string; userId?: string }) =>
      makeInteraction("modal", input),
  };
};

describe("makeQuestionRuntime", () => {
  test("posts a question batch once and resumes typing after a reply event", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );
    await Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    expect((await getRef(harness.postedPayloads)).length).toBe(1);
    expect(await getRef(harness.questionReplyTargetIds)).toEqual(["origin-message"]);
    expect(await getRef(harness.typingPauseCount)).toBe(1);

    await Effect.runPromise(
      harness.runtime.routeEvent({
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
      replyTargetId: "follow-up-message",
    });

    await Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    expect(await getRef(harness.rejectCalls)).toEqual([harness.request.id]);
    expect(await getRef(harness.sentQuestionUiFailures)).toEqual(["post failed"]);
    expect(await getRef(harness.questionUiFailureTargetIds)).toEqual(["follow-up-message"]);
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
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: `ocq:${harness.request.id}:0:submit`,
          userId: "intruder",
        }),
      ),
    );

    expect(await getRef(harness.interactionReplies)).toEqual([]);
    expect(await getRef(harness.replyCalls)).toEqual([harness.request.id]);
  });

  test("expires question batches for a session and treats later interactions as expired", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );
    await Effect.runPromise(
      harness.runtime.terminateForSession(harness.session.opencode.sessionId),
    );
    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: `ocq:${harness.request.id}:0:submit`,
        }),
      ),
    );

    expect((await getRef(harness.editedPayloads)).length).toBe(1);
    expect((await getRef(harness.interactionReplies))[0]?.content).toBe(
      "This question prompt has expired.",
    );
  });

  test("shows a late question card and clears interruptRequested once the question wins the race", async () => {
    const harness = await makeHarness();
    harness.activeRun.interruptRequested = true;

    await Effect.runPromise(
      harness.runtime.routeEvent({
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

  test("anchors question cards to the current prompt reply target", async () => {
    const harness = await makeHarness({ replyTargetId: "follow-up-message" });

    await Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    expect(await getRef(harness.questionReplyTargetIds)).toEqual(["follow-up-message"]);
  });

  test("expires a submitting batch if the session disappears before the reply RPC starts", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );
    await Effect.runPromise(Ref.set(harness.sessionContextRef, null));
    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: `ocq:${harness.request.id}:0:submit`,
        }),
      ),
    );

    expect(await getRef(harness.replyCalls)).toEqual([]);
    expect(
      await Effect.runPromise(harness.runtime.rawRuntime.hasPendingQuestions("session-1")),
    ).toBe(false);
  });

  test("renders shutdown-expired questions immediately when shutdown begins", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );
    await Effect.runPromise(harness.runtime.shutdown());

    const edits = await getRef(harness.editedPayloads);
    expect(edits).toHaveLength(1);
    expect(JSON.stringify(edits[0])).toContain("Questions expired");
    expect(JSON.stringify(edits[0])).toContain(
      "This question prompt expired before it was answered.",
    );
  });

  test("replies with a stale-state error after a newer page action wins", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.routeEvent({
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
    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: `ocq:${harness.request.id}:0:question-prev`,
          userId: "intruder",
        }),
      ),
    );

    expect((await getRef(harness.interactionReplies)).at(-1)?.content).toBe(
      "Another user updated this question prompt before your action was applied. Review the latest card and try again.",
    );
  });

  test("replies with a stale-state error for modal submissions from an old version", async () => {
    const harness = await makeHarness();

    await Effect.runPromise(
      harness.runtime.routeEvent({
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
    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeModalInteraction({
          customId: `ocq:${harness.request.id}:0:modal:0`,
          value: "Other",
          userId: "intruder",
        }),
      ),
    );

    expect((await getRef(harness.interactionReplies)).at(-1)?.content).toBe(
      "Another user updated this question prompt before your action was applied. Review the latest card and try again.",
    );
  });

  test("shuts down open questions per session and ignores later question events", async () => {
    const harness = await makeHarness();

    const firstResult = await Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: harness.request,
      }),
    );

    expect(firstResult).not.toBeNull();
    expect(await Effect.runPromise(harness.runtime.rawRuntime.hasPendingQuestionsAnywhere())).toBe(
      true,
    );

    await Effect.runPromise(harness.runtime.shutdown());

    expect(await getRef(harness.rejectCalls)).toEqual([harness.request.id]);
    expect(await Effect.runPromise(harness.runtime.rawRuntime.hasPendingQuestionsAnywhere())).toBe(
      false,
    );
    expect(await getRef(harness.postedPayloads)).toHaveLength(1);
    expect(await getRef(harness.editedPayloads)).toHaveLength(1);
    expect(JSON.stringify((await getRef(harness.editedPayloads))[0])).toContain(
      "Questions expired",
    );

    const lateResult = await Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request: makeRequest("req-2"),
      }),
    );

    expect(lateResult).toBeNull();
    expect(await getRef(harness.rejectCalls)).toEqual([harness.request.id]);
  });
});
