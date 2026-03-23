import type { Message } from "discord.js";
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";

import type { PendingQuestionBatchView, QuestionDraft } from "@/discord/question-card.ts";

export type QuestionBatchLifecycle =
  | "posting"
  | "active"
  | "submitting"
  | "answered"
  | "rejected"
  | "expired";

export type QuestionBatchAttachment = { _tag: "pending" } | { _tag: "attached"; message: Message };

export const isAttachedQuestionBatchAttachment = (
  attachment: QuestionBatchAttachment,
): attachment is { _tag: "attached"; message: Message } => attachment._tag === "attached";

export type QuestionBatchDomainState = {
  request: QuestionRequest;
  version: number;
  page: number;
  optionPages: ReadonlyArray<number>;
  drafts: ReadonlyArray<QuestionDraft>;
  lifecycle: QuestionBatchLifecycle;
  resolvedAnswers?: ReadonlyArray<QuestionAnswer>;
};

export type QuestionBatchRuntimeState = {
  sessionId: string;
  channelId: string;
  replyTargetMessage: Message;
  lastModifiedBy: string | null;
  attachment: QuestionBatchAttachment;
};

export type QuestionWorkflowBatch = {
  domain: QuestionBatchDomainState;
  runtime: QuestionBatchRuntimeState;
};

const emptyResolvedAnswers = (request: QuestionRequest): Array<QuestionAnswer> =>
  request.questions.map(() => []);

export const createQuestionWorkflowBatch = (input: {
  sessionId: string;
  request: QuestionRequest;
  channelId: string;
  replyTargetMessage: Message;
  drafts: ReadonlyArray<QuestionDraft>;
}): QuestionWorkflowBatch => ({
  domain: {
    request: input.request,
    version: 0,
    page: 0,
    optionPages: input.request.questions.map(() => 0),
    drafts: input.drafts,
    lifecycle: "posting",
  },
  runtime: {
    sessionId: input.sessionId,
    channelId: input.channelId,
    replyTargetMessage: input.replyTargetMessage,
    lastModifiedBy: null,
    attachment: { _tag: "pending" },
  },
});

export const questionBatchView = (batch: QuestionWorkflowBatch): PendingQuestionBatchView => ({
  sessionId: batch.runtime.sessionId,
  request: batch.domain.request,
  version: batch.domain.version,
  page: batch.domain.page,
  optionPages: batch.domain.optionPages,
  drafts: batch.domain.drafts,
  status: batch.domain.lifecycle === "posting" ? "active" : batch.domain.lifecycle,
  resolvedAnswers: batch.domain.resolvedAnswers,
});

export const isPendingQuestionBatch = (batch: QuestionWorkflowBatch) =>
  ["posting", "active", "submitting"].includes(batch.domain.lifecycle);

export const isTerminalQuestionBatch = (batch: QuestionWorkflowBatch) =>
  ["answered", "rejected", "expired"].includes(batch.domain.lifecycle);

export const attachQuestionMessage = (
  batch: QuestionWorkflowBatch,
  message: Message,
): QuestionWorkflowBatch => ({
  ...batch,
  runtime: {
    ...batch.runtime,
    attachment: { _tag: "attached", message },
  },
});

export const activateQuestionBatch = (batch: QuestionWorkflowBatch): QuestionWorkflowBatch => ({
  ...batch,
  domain: {
    ...batch.domain,
    lifecycle: "active",
  },
});

export const setQuestionBatchStatus = (
  batch: QuestionWorkflowBatch,
  lifecycle: "active" | "submitting" | "answered" | "rejected",
  resolvedAnswers?: ReadonlyArray<QuestionAnswer>,
): QuestionWorkflowBatch => ({
  ...batch,
  domain: {
    ...batch.domain,
    lifecycle,
    resolvedAnswers:
      resolvedAnswers ??
      (lifecycle === "rejected" ? emptyResolvedAnswers(batch.domain.request) : undefined),
  },
});

export const terminateQuestionBatch = (batch: QuestionWorkflowBatch): QuestionWorkflowBatch => ({
  ...batch,
  domain: {
    ...batch.domain,
    lifecycle: "expired",
  },
});

export const persistQuestionBatchUpdate = (
  batch: QuestionWorkflowBatch,
  actorId: string,
  update: (batch: QuestionWorkflowBatch) => QuestionWorkflowBatch,
): QuestionWorkflowBatch => {
  const updated = update(batch);
  if (updated === batch) {
    return batch;
  }

  return {
    ...updated,
    domain: {
      ...updated.domain,
      version: batch.domain.version + 1,
    },
    runtime: {
      ...updated.runtime,
      lastModifiedBy: actorId,
    },
  };
};
