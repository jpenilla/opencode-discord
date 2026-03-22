import { describe, expect, test } from "bun:test";
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";
import type { Interaction, Message, MessageCreateOptions, MessageEditOptions } from "discord.js";
import { Deferred, Effect, Layer, Ref } from "effect";

import { OpencodeService, type OpencodeServiceShape } from "@/opencode/service.ts";
import {
  applyQuestionSignals,
  questionTypingAction,
  runQuestionTypingAction,
  type QuestionWorkflowSignal,
} from "@/sessions/question/question-run-state.ts";
import {
  makeQuestionRuntime,
  QuestionSessionLookup,
} from "@/sessions/question/question-runtime.ts";
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts";
import { Logger } from "@/util/logging.ts";
import { makePostedMessage, makeRecordedComponentInteraction } from "../../support/discord.ts";
import { makeMessage, makeSilentLogger } from "../../support/fixtures.ts";
import { failTest } from "../../support/errors.ts";
import { makeRef, runTestEffect } from "../../support/runtime.ts";
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

const push = <A>(values: A[], value: A) => (values.push(value), value);
type HarnessOptions = {
  postQuestionResult?: "success" | "failure";
  rejectResult?: "success" | "failure";
  blockQuestionPost?: boolean;
  replyTargetId?: string;
};
type Harness = Awaited<ReturnType<typeof makeHarness>>;
type SessionContext = { session: ChannelSession; activeRun: ActiveRun };
type InteractionReply = { content?: string | null };

const makeHarness = async (options?: HarnessOptions) => {
  const postedPayloads: MessageCreateOptions[] = [];
  const editedPayloads: MessageEditOptions[] = [];
  const interactionUpdates: unknown[] = [];
  const interactionReplies: InteractionReply[] = [];
  const sentQuestionUiFailures: string[] = [];
  const questionReplyTargetIds: string[] = [];
  const questionUiFailureTargetIds: string[] = [];
  const replyCalls: string[] = [];
  const rejectCalls: string[] = [];
  let typingPauseCount = 0;
  let typingResumeCount = 0;
  let typingStopCount = 0;
  const typingPausedRef = await makeRef(false);
  const questionPostStarted = await runTestEffect(Deferred.make<void>());
  const allowQuestionPost = await runTestEffect(Deferred.make<void>());

  const questionMessage: Message = makePostedMessage(
    "question-message",
    async (payload: MessageEditOptions) => push(editedPayloads, payload) && questionMessage,
  );

  const makeReplyTargetMessage = (id: string) =>
    makeMessage({
      id,
      channelId: "channel-1",
      author: { id: "owner", tag: "owner#0001" },
      reply: async (payload: MessageCreateOptions) => {
        push(questionReplyTargetIds, id);
        push(postedPayloads, payload);
        if (options?.blockQuestionPost) {
          await runTestEffect(Deferred.succeed(questionPostStarted, undefined).pipe(Effect.ignore));
          await runTestEffect(Deferred.await(allowQuestionPost));
        }
        if (options?.postQuestionResult === "failure") {
          throw new Error("post failed");
        }
        return questionMessage;
      },
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
      pause: async () => void (typingPauseCount += 1),
      resume: () => void (typingResumeCount += 1),
      stop: async () => void (typingStopCount += 1),
    },
  });

  const session: ChannelSession = makeTestSession({
    rootDir: "/tmp/root",
    activeRun,
  });
  const sessionContextRef = await runTestEffect(
    Ref.make<SessionContext | null>({ session, activeRun }),
  );

  const rawRuntime = await runTestEffect(
    makeQuestionRuntime((message, error) =>
      Effect.sync(() => {
        questionUiFailureTargetIds.push(message.id);
        sentQuestionUiFailures.push(String(error));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(QuestionSessionLookup, {
            getSessionContext: () => Ref.get(sessionContextRef),
          }),
          Layer.succeed(
            OpencodeService,
            unsafeStub<OpencodeServiceShape>({
              replyToQuestion: (_opencode: unknown, requestId: string) =>
                Effect.sync(() => {
                  replyCalls.push(requestId);
                }),
              rejectQuestion: (_opencode: unknown, requestId: string) =>
                Effect.sync(() => {
                  rejectCalls.push(requestId);
                }).pipe(
                  Effect.flatMap(() =>
                    options?.rejectResult === "failure" ? failTest("reject failed") : Effect.void,
                  ),
                ),
            }),
          ),
          Layer.succeed(Logger, makeSilentLogger()),
        ),
      ),
    ),
  );

  const recordInteractionReply = (payload: unknown) =>
    Promise.resolve(push(interactionReplies, payload as InteractionReply)).then(() => undefined);
  const recordInteractionUpdate = (payload: unknown) =>
    Promise.resolve(push(interactionUpdates, payload)).then(() => undefined);

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
  const interactionBase = { onReply: recordInteractionReply, onUpdate: recordInteractionUpdate };

  return {
    runtime,
    session,
    sessionContextRef,
    activeRun,
    request: makeRequest(),
    postedPayloads,
    editedPayloads,
    interactionReplies,
    interactionUpdates,
    sentQuestionUiFailures,
    questionReplyTargetIds,
    questionUiFailureTargetIds,
    replyCalls,
    rejectCalls,
    readTypingPauseCount: () => typingPauseCount,
    readTypingResumeCount: () => typingResumeCount,
    readTypingStopCount: () => typingStopCount,
    makeButtonInteraction: (input: { customId: string; userId?: string; messageId?: string }) =>
      makeRecordedComponentInteraction("button", {
        ...input,
        ...interactionBase,
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
        ...interactionBase,
        update: () => Promise.resolve(questionMessage),
      }) as Interaction,
    makeModalInteraction: (input: { customId: string; value: string; userId?: string }) =>
      makeRecordedComponentInteraction("modal", {
        ...input,
        messageId: questionMessage.id,
        onReply: recordInteractionReply,
        followUp: () => Promise.resolve(questionMessage),
      }) as Interaction,
  };
};

describe("makeQuestionRuntime", () => {
  const ask = (harness: Harness, request = harness.request) =>
    Effect.runPromise(
      harness.runtime.routeEvent({
        type: "asked",
        sessionId: harness.session.opencode.sessionId,
        request,
      }),
    );

  const askHarness = async (options?: Parameters<typeof makeHarness>[0]) =>
    makeHarness(options).then(async (harness) => (await ask(harness), harness));
  const interact = (harness: Harness, interaction: Interaction) =>
    Effect.runPromise(harness.runtime.handleInteraction(interaction));
  const press = (harness: Harness, suffix: string, userId?: string) =>
    interact(
      harness,
      harness.makeButtonInteraction({ customId: questionId(harness, suffix), userId }),
    );
  const select = (harness: Harness, suffix: string, values: string[]) =>
    interact(
      harness,
      harness.makeSelectInteraction({ customId: questionId(harness, suffix), values }),
    );
  const modal = (harness: Harness, suffix: string, value: string, userId?: string) =>
    interact(
      harness,
      harness.makeModalInteraction({ customId: questionId(harness, suffix), value, userId }),
    );
  const questionId = (harness: Harness, suffix: string) => `ocq:${harness.request.id}:0:${suffix}`;
  const hasPendingQuestions = (harness: Harness) =>
    Effect.runPromise(harness.runtime.rawRuntime.hasPendingQuestions("session-1"));
  const hasPendingQuestionsAnywhere = (harness: Harness) =>
    Effect.runPromise(harness.runtime.rawRuntime.hasPendingQuestionsAnywhere());
  const expectStaleStateReply = (harness: Harness) =>
    expect(harness.interactionReplies.at(-1)?.content).toBe(staleStateMessage);

  test("posts a question batch once and resumes typing after a reply event", async () => {
    const harness = await askHarness();
    await ask(harness);

    expect(harness.postedPayloads).toHaveLength(1);
    expect(harness.questionReplyTargetIds).toEqual(["origin-message"]);
    expect(harness.readTypingPauseCount()).toBe(1);

    await Effect.runPromise(
      harness.runtime.routeEvent({
        type: "replied",
        sessionId: harness.session.opencode.sessionId,
        requestId: harness.request.id,
        answers: [["Yes"]] satisfies ReadonlyArray<QuestionAnswer>,
      }),
    );

    expect(harness.editedPayloads).toHaveLength(1);
    expect(harness.readTypingResumeCount()).toBe(1);
  });

  test("sends a UI failure reply when posting the question and rejecting it both fail", async () => {
    const harness = await askHarness({
      postQuestionResult: "failure",
      rejectResult: "failure",
      replyTargetId: "follow-up-message",
    });

    expect(harness.rejectCalls).toEqual([harness.request.id]);
    expect(harness.sentQuestionUiFailures).toEqual(["post failed"]);
    expect(harness.questionUiFailureTargetIds).toEqual(["follow-up-message"]);
    expect(harness.readTypingStopCount()).toBe(1);
    expect(harness.activeRun.questionOutcome).toEqual({
      _tag: "ui-failure",
      message: "post failed",
      notified: true,
    });
  });

  test("allows question interactions from other users", async () => {
    const harness = await askHarness();

    await press(harness, "submit", "intruder");

    expect(harness.interactionReplies).toEqual([]);
    expect(harness.replyCalls).toEqual([harness.request.id]);
  });

  test("expires question batches for a session and treats later interactions as expired", async () => {
    const harness = await askHarness();

    await Effect.runPromise(
      harness.runtime.terminateForSession(harness.session.opencode.sessionId),
    );
    await press(harness, "submit");

    expect(harness.editedPayloads).toHaveLength(1);
    expect(harness.interactionReplies[0]?.content).toBe("This question prompt has expired.");
  });

  test("shows a late question card and clears interruptRequested once the question wins the race", async () => {
    const harness = await makeHarness();
    harness.activeRun.interruptRequested = true;

    await ask(harness);

    expect(harness.activeRun.interruptRequested).toBe(false);
    expect(harness.rejectCalls).toEqual([]);
    expect(harness.postedPayloads).toHaveLength(1);
    expect(harness.editedPayloads).toHaveLength(0);
  });

  test("anchors question cards to the current prompt reply target", async () => {
    const harness = await askHarness({ replyTargetId: "follow-up-message" });

    expect(harness.questionReplyTargetIds).toEqual(["follow-up-message"]);
  });

  test("expires a submitting batch if the session disappears before the reply RPC starts", async () => {
    const harness = await askHarness();
    await Effect.runPromise(Ref.set(harness.sessionContextRef, null));
    await press(harness, "submit");

    expect(harness.replyCalls).toEqual([]);
    expect(await hasPendingQuestions(harness)).toBe(false);
  });

  test("renders shutdown-expired questions immediately when shutdown begins", async () => {
    const harness = await askHarness();
    await Effect.runPromise(harness.runtime.shutdown());

    const edits = harness.editedPayloads;
    expect(edits).toHaveLength(1);
    expect(JSON.stringify(edits[0])).toContain("Questions expired");
    expect(JSON.stringify(edits[0])).toContain(
      "This question prompt expired before it was answered.",
    );
  });

  test("replies with a stale-state error after a newer page action wins", async () => {
    const harness = await askHarness();

    await press(harness, "question-next");
    await press(harness, "question-prev", "intruder");

    expectStaleStateReply(harness);
  });

  test("replies with a stale-state error for modal submissions from an old version", async () => {
    const harness = await askHarness();

    await select(harness, "select:0", ["Yes"]);

    expect(harness.interactionUpdates).toHaveLength(1);

    await modal(harness, "modal:0", "Other", "intruder");

    expectStaleStateReply(harness);
  });

  test("shuts down open questions per session and ignores later question events", async () => {
    const harness = await makeHarness();

    const firstResult = await ask(harness);

    expect(firstResult).not.toBeNull();
    expect(await hasPendingQuestionsAnywhere(harness)).toBe(true);

    await Effect.runPromise(harness.runtime.shutdown());

    expect(harness.rejectCalls).toEqual([harness.request.id]);
    expect(await hasPendingQuestionsAnywhere(harness)).toBe(false);
    expect(harness.postedPayloads).toHaveLength(1);
    expect(harness.editedPayloads).toHaveLength(1);
    expect(JSON.stringify(harness.editedPayloads[0])).toContain("Questions expired");

    const lateResult = await ask(harness, makeRequest("req-2"));

    expect(lateResult).toBeNull();
    expect(harness.rejectCalls).toEqual([harness.request.id]);
  });
});
