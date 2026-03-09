import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"

import {
  buildQuestionAnswers,
  clearQuestionDraft,
  questionDrafts,
  setQuestionCustomAnswer,
  setQuestionOptionSelection,
} from "@/discord/question-card.ts"
import { setQuestionBatchStatus, terminateQuestionBatch, type QuestionBatchState } from "@/sessions/question-batch-state.ts"

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
}

const makeBatch = (): QuestionBatchState => ({
  request,
  page: 0,
  optionPages: [0, 0],
  drafts: questionDrafts(request),
  status: "active",
})

describe("question draft helpers", () => {
  test("single-select custom answers replace selected options", () => {
    const draft = setQuestionCustomAnswer(request.questions[0]!, { selectedOptions: ["TypeScript"], customAnswer: null }, "Other")
    expect(draft).toEqual({
      selectedOptions: [],
      customAnswer: "Other",
    })
  })

  test("multi-select option updates retain selections from other pages", () => {
    const updated = setQuestionOptionSelection({
      question: request.questions[1]!,
      draft: { selectedOptions: ["Web", "Infra"], customAnswer: null },
      visibleOptions: ["Web", "CLI"],
      selectedOptions: ["CLI"],
    })

    expect(updated.selectedOptions).toEqual(["Infra", "CLI"])
  })

  test("buildQuestionAnswers combines drafts into OpenCode answer payloads", () => {
    const drafts = [
      { selectedOptions: ["TypeScript"], customAnswer: null },
      { selectedOptions: ["CLI"], customAnswer: "Other" },
    ]

    expect(buildQuestionAnswers(request, drafts)).toEqual([["TypeScript"], ["CLI", "Other"]])
  })
})

describe("question batch state transitions", () => {
  test("can enter submitting and return to active without resolved answers", () => {
    const submitting = setQuestionBatchStatus(makeBatch(), "submitting")
    expect(submitting.status).toBe("submitting")
    expect(submitting.resolvedAnswers).toBeUndefined()

    const restored = setQuestionBatchStatus(submitting, "active")
    expect(restored.status).toBe("active")
    expect(restored.resolvedAnswers).toBeUndefined()
  })

  test("stores resolved answers when finalized as answered", () => {
    const answers = [["TypeScript"], ["CLI", "Other"]]
    const finalized = setQuestionBatchStatus(makeBatch(), "answered", answers)

    expect(finalized.status).toBe("answered")
    expect(finalized.resolvedAnswers).toEqual(answers)
  })

  test("fills rejected batches with empty resolved answers", () => {
    const rejected = setQuestionBatchStatus(makeBatch(), "rejected")

    expect(rejected.status).toBe("rejected")
    expect(rejected.resolvedAnswers).toEqual([[], []])
  })

  test("marks active batches as expired", () => {
    const expired = terminateQuestionBatch(makeBatch(), "expired")

    expect(expired.status).toBe("expired")
  })

  test("marks active batches as interrupted", () => {
    const interrupted = terminateQuestionBatch(makeBatch(), "interrupted")

    expect(interrupted.status).toBe("interrupted")
  })

  test("clearQuestionDraft returns an empty draft", () => {
    expect(clearQuestionDraft()).toEqual({
      selectedOptions: [],
      customAnswer: null,
    })
  })
})
