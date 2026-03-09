import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"

import type { QuestionBatchStatus, QuestionDraft } from "@/discord/question-card.ts"

export type QuestionBatchState = {
  request: QuestionRequest
  page: number
  optionPages: ReadonlyArray<number>
  drafts: ReadonlyArray<QuestionDraft>
  status: QuestionBatchStatus | "expired"
  resolvedAnswers?: ReadonlyArray<QuestionAnswer>
}

const emptyResolvedAnswers = (request: QuestionRequest): Array<QuestionAnswer> => request.questions.map(() => [])

export const setQuestionBatchStatus = <T extends QuestionBatchState>(
  batch: T,
  status: QuestionBatchStatus,
  resolvedAnswers?: ReadonlyArray<QuestionAnswer>,
): T =>
  ({
    ...batch,
    status,
    resolvedAnswers: resolvedAnswers ?? (status === "rejected" ? emptyResolvedAnswers(batch.request) : undefined),
  }) as T

export const expireQuestionBatch = <T extends QuestionBatchState>(batch: T): T =>
  ({
    ...batch,
    status: "expired",
  }) as T
