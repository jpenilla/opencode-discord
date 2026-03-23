import { describe, expect, test } from "bun:test";
import type { QuestionRequest } from "@opencode-ai/sdk/v2";

import {
  buildQuestionAnswers,
  clearQuestionDraft,
  questionDrafts,
  setQuestionCustomAnswer,
  setQuestionOptionSelection,
} from "@/discord/question-card.ts";
import {
  activateQuestionBatch,
  createQuestionWorkflowBatch,
  setQuestionBatchStatus,
  terminateQuestionBatch,
} from "@/sessions/question/batch-state.ts";

const request: QuestionRequest = {
  id: "req-1",
  sessionID: "ses-1",
  questions: [
    {
      header: "Favorite language",
      question: "Pick one",
      options: [
        { label: "TypeScript", description: "TS" },
        { label: "Rust", description: "Rust" },
      ],
    },
    {
      header: "Focus areas",
      question: "Pick many",
      options: [
        { label: "Web", description: "Web apps" },
        { label: "CLI", description: "Command line" },
        { label: "Infra", description: "Infrastructure" },
      ],
      multiple: true,
    },
  ],
  tool: {
    messageID: "msg-1",
    callID: "call-1",
  },
};

const makeBatch = () =>
  activateQuestionBatch(
    createQuestionWorkflowBatch({
      sessionId: "ses-1",
      request,
      channelId: "channel-1",
      replyTargetMessage: { id: "reply-target" } as never,
      drafts: questionDrafts(request),
    }),
  );

describe("question draft helpers", () => {
  test("single-select custom answers replace selected options", () => {
    expect(
      setQuestionCustomAnswer(
        request.questions[0]!,
        { selectedOptions: ["TypeScript"], customAnswer: null },
        "Other",
      ),
    ).toEqual({
      selectedOptions: [],
      customAnswer: "Other",
    });
  });

  test("multi-select option updates retain selections from other pages", () => {
    expect(
      setQuestionOptionSelection({
        question: request.questions[1]!,
        draft: { selectedOptions: ["Web", "Infra"], customAnswer: null },
        visibleOptions: ["Web", "CLI"],
        selectedOptions: ["CLI"],
      }).selectedOptions,
    ).toEqual(["Infra", "CLI"]);
  });

  test("buildQuestionAnswers combines drafts into OpenCode answer payloads", () => {
    const drafts = [
      { selectedOptions: ["TypeScript"], customAnswer: null },
      { selectedOptions: ["CLI"], customAnswer: "Other" },
    ];

    expect(buildQuestionAnswers(request, drafts)).toEqual([["TypeScript"], ["CLI", "Other"]]);
  });
});

describe("question batch state transitions", () => {
  test("can enter submitting and return to active without resolved answers", () => {
    const submitting = setQuestionBatchStatus(makeBatch(), "submitting");
    expect(submitting.domain.lifecycle).toBe("submitting");
    expect(submitting.domain.resolvedAnswers).toBeUndefined();

    const restored = setQuestionBatchStatus(submitting, "active");
    expect(restored.domain.lifecycle).toBe("active");
    expect(restored.domain.resolvedAnswers).toBeUndefined();
  });

  test("stores resolved answers when finalized as answered", () => {
    const answers = [["TypeScript"], ["CLI", "Other"]];
    expect(setQuestionBatchStatus(makeBatch(), "answered", answers).domain).toMatchObject({
      lifecycle: "answered",
      resolvedAnswers: answers,
    });
  });

  test("fills rejected batches with empty resolved answers", () => {
    expect(setQuestionBatchStatus(makeBatch(), "rejected").domain).toMatchObject({
      lifecycle: "rejected",
      resolvedAnswers: [[], []],
    });
  });

  test("marks active batches as expired", () => {
    expect(terminateQuestionBatch(makeBatch()).domain.lifecycle).toBe("expired");
  });

  test("clearQuestionDraft returns an empty draft", () => {
    expect(clearQuestionDraft()).toEqual({
      selectedOptions: [],
      customAnswer: null,
    });
  });
});
