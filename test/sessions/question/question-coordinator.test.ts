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
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts";
import { formatError } from "@/util/errors.ts";
import { makePostedMessage, makeRecordedComponentInteraction } from "../../support/discord.ts";
import { getRef, makeMessage, makeSilentLogger } from "../../support/fixtures.ts";
import { failTest } from "../../support/errors.ts";
import { appendRef, makeRef, runTestEffect } from "../../support/runtime.ts";
import { makeTestActiveRun, makeTestSession } from "../../support/session.ts";
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

const staleStateMessage =
  "Another user updated this question prompt before your action was applied. Review the latest card and try again.";

const makeHarness = async (options?: {
  postQuestionResult?: "success" | "failure";
  rejectResult?: "success" | "failure";
  blockQuestionPost?: boolean;
  replyTargetId?: string;
}) => {
  const postedPayloads = await makeRef<MessageCreateOptions[]>([]);
  const editedPayloads = await makeRef<MessageEditOptions[]>([]);
  const interactionReplies = await makeRef<Array<{ content?: string | null }>>([]);
  const sentQuestionUiFailures = await makeRef<string[]>([]);
  const questionReplyTargetIds = await makeRef<string[]>([]);
  const questionUiFailureTargetIds = await makeRef<string[]>([]);
  const replyCalls = await makeRef<string[]>([]);
  const rejectCalls = await makeRef<string[]>([]);
  const typingPauseCount = await makeRef(0);
  const typingResumeCount = await makeRef(0);
  const typingStopCount = await makeRef(0);
  const typingPausedRef = await makeRef(false);
  const questionPostStarted = await runTestEffect(Deferred.make<void>());
  const allowQuestionPost = await runTestEffect(Deferred.make<void>());

  const questionMessage: Message = makePostedMessage(
    "question-message",
    (payload: MessageEditOptions) =>
      runTestEffect(appendRef(editedPayloads, payload)).then(() => questionMessage),
  );

  const makeReplyTargetMessage = (id: string) =>
    makeMessage({
      id,
      channelId: "channel-1",
      author: { id: "owner", tag: "owner#0001" },
      reply: (payload: MessageCreateOptions) =>
        runTestEffect(appendRef(questionReplyTargetIds, id)).then(() =>
          runTestEffect(appendRef(postedPayloads, payload)).then(async () => {
            if (options?.blockQuestionPost) {
              await runTestEffect(
                Deferred.succeed(questionPostStarted, undefined).pipe(Effect.ignore),
              );
              await runTestEffect(Deferred.await(allowQuestionPost));
            }
            if (options?.postQuestionResult === "failure") {
              throw new Error("post failed");
            }
            return questionMessage;
          }),
        ),
    });

  const originMessage = makeReplyTargetMessage("origin-message");
  const replyTargetMessage =
    options?.replyTargetId && options.replyTargetId !== originMessage.id
      ? makeReplyTargetMessage(options.replyTargetId)
      : originMessage;

  const { activeRun } = await makeTestActiveRun({
    originMessage,
    currentPromptContext: {
      kind: replyTargetMessage.id === originMessage.id ? "initial" : "follow-up",
      prompt: "prompt",
      replyTargetMessage,
      requestMessages: [replyTargetMessage],
    },
    typing: {
      pause: () => Effect.runPromise(Ref.update(typingPauseCount, (count) => count + 1)),
      resume: () => {
        void Effect.runPromise(Ref.update(typingResumeCount, (count) => count + 1));
      },
      stop: () => Effect.runPromise(Ref.update(typingStopCount, (count) => count + 1)),
    },
  });

  const session: ChannelSession = makeTestSession({
    rootDir: "/tmp/root",
    activeRun,
  });
  const sessionContextRef = await runTestEffect(
    Ref.make<{ session: ChannelSession; activeRun: ActiveRun } | null>({ session, activeRun }),
  );

  const rawRuntime = await runTestEffect(
    makeQuestionRuntime({
      getSessionContext: () => Ref.get(sessionContextRef),
      replyToQuestion: (_opencode, requestId) => appendRef(replyCalls, requestId),
      rejectQuestion: (_opencode, requestId) =>
        appendRef(rejectCalls, requestId).pipe(
          Effect.flatMap(() =>
            options?.rejectResult === "failure" ? failTest("reject failed") : Effect.void,
          ),
        ),
      sendQuestionUiFailure: (message, error) =>
        appendRef(questionUiFailureTargetIds, message.id).pipe(
          Effect.andThen(appendRef(sentQuestionUiFailures, String(error))),
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
      makeRecordedComponentInteraction("button", {
        ...input,
        onReply: (payload) =>
          runTestEffect(appendRef(interactionReplies, payload as { content?: string | null })),
        update: () => Promise.resolve(questionMessage),
        followUp: () => Promise.resolve(questionMessage),
      }) as Interaction,
    makeSelectInteraction: (input: {
      customId: string;
      values: string[];
      userId?: string;
      messageId?: string;
    }) =>
      makeRecordedComponentInteraction("select", {
        ...input,
        onReply: (payload) =>
          runTestEffect(appendRef(interactionReplies, payload as { content?: string | null })),
        update: () => Promise.resolve(questionMessage),
      }) as Interaction,
    makeModalInteraction: (input: { customId: string; value: string; userId?: string }) =>
      makeRecordedComponentInteraction("modal", {
        ...input,
        messageId: questionMessage.id,
        onReply: (payload) =>
          runTestEffect(appendRef(interactionReplies, payload as { content?: string | null })),
        followUp: () => Promise.resolve(questionMessage),
      }) as Interaction,
  };
};

describe("makeQuestionRuntime", () => {
  const ask = (harness: Awaited<ReturnType<typeof makeHarness>>, request = harness.request) =>
    Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request,
      }),
    );

  const questionId = (harness: Awaited<ReturnType<typeof makeHarness>>, suffix: string) =>
    `ocq:${harness.request.id}:0:${suffix}`;

  test("posts a question batch once and resumes typing after a reply event", async () => {
    const harness = await makeHarness();

    await ask(harness);
    await ask(harness);

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

    await ask(harness);

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

    await ask(harness);

    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: questionId(harness, "submit"),
          userId: "intruder",
        }),
      ),
    );

    expect(await getRef(harness.interactionReplies)).toEqual([]);
    expect(await getRef(harness.replyCalls)).toEqual([harness.request.id]);
  });

  test("expires question batches for a session and treats later interactions as expired", async () => {
    const harness = await makeHarness();

    await ask(harness);
    await Effect.runPromise(
      harness.runtime.terminateForSession(harness.session.opencode.sessionId),
    );
    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: questionId(harness, "submit"),
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

    await ask(harness);

    expect(harness.activeRun.interruptRequested).toBe(false);
    expect(await getRef(harness.rejectCalls)).toEqual([]);
    expect(await getRef(harness.postedPayloads)).toHaveLength(1);
    expect(await getRef(harness.editedPayloads)).toHaveLength(0);
  });

  test("anchors question cards to the current prompt reply target", async () => {
    const harness = await makeHarness({ replyTargetId: "follow-up-message" });

    await ask(harness);

    expect(await getRef(harness.questionReplyTargetIds)).toEqual(["follow-up-message"]);
  });

  test("expires a submitting batch if the session disappears before the reply RPC starts", async () => {
    const harness = await makeHarness();

    await ask(harness);
    await Effect.runPromise(Ref.set(harness.sessionContextRef, null));
    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: questionId(harness, "submit"),
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

    await ask(harness);
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

    await ask(harness);
    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: questionId(harness, "question-next"),
        }),
      ),
    );
    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeButtonInteraction({
          customId: questionId(harness, "question-prev"),
          userId: "intruder",
        }),
      ),
    );

    expect((await getRef(harness.interactionReplies)).at(-1)?.content).toBe(staleStateMessage);
  });

  test("replies with a stale-state error for modal submissions from an old version", async () => {
    const harness = await makeHarness();

    await ask(harness);
    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeSelectInteraction({
          customId: questionId(harness, "select:0"),
          values: ["Yes"],
        }),
      ),
    );
    await Effect.runPromise(
      harness.runtime.handleInteraction(
        harness.makeModalInteraction({
          customId: questionId(harness, "modal:0"),
          value: "Other",
          userId: "intruder",
        }),
      ),
    );

    expect((await getRef(harness.interactionReplies)).at(-1)?.content).toBe(staleStateMessage);
  });

  test("shuts down open questions per session and ignores later question events", async () => {
    const harness = await makeHarness();

    const firstResult = await ask(harness);

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

    const lateResult = await ask(harness, makeRequest("req-2"));

    expect(lateResult).toBeNull();
    expect(await getRef(harness.rejectCalls)).toEqual([harness.request.id]);
  });
});
