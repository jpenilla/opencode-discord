import type { Message } from "discord.js";
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";

import type {
  PendingQuestionBatchView,
  QuestionBatchCardStatus,
  QuestionDraft,
} from "@/discord/question-card.ts";

export type QuestionBatchLifecycle =
  | "posting"
  | "active"
  | "submitting"
  | "answered"
  | "rejected"
  | "expired";

export type QuestionBatchAttachment = { _tag: "pending" } | { _tag: "attached"; message: Message };

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
const withQuestionBatchDomain = (
  batch: QuestionWorkflowBatch,
  domain: Partial<QuestionBatchDomainState>,
): QuestionWorkflowBatch => ({
  ...batch,
  domain: {
    ...batch.domain,
    ...domain,
  },
});
const withQuestionBatchRuntime = (
  batch: QuestionWorkflowBatch,
  runtime: Partial<QuestionBatchRuntimeState>,
): QuestionWorkflowBatch => ({
  ...batch,
  runtime: {
    ...batch.runtime,
    ...runtime,
  },
});

export const createQuestionWorkflowBatch = (input: {
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
    channelId: input.channelId,
    replyTargetMessage: input.replyTargetMessage,
    lastModifiedBy: null,
    attachment: { _tag: "pending" },
  },
});

export const questionBatchCardStatus = (batch: QuestionWorkflowBatch): QuestionBatchCardStatus =>
  batch.domain.lifecycle === "posting" ? "active" : batch.domain.lifecycle;

export const questionBatchView = (batch: QuestionWorkflowBatch): PendingQuestionBatchView => ({
  request: batch.domain.request,
  version: batch.domain.version,
  page: batch.domain.page,
  optionPages: batch.domain.optionPages,
  drafts: batch.domain.drafts,
  status: questionBatchCardStatus(batch),
  resolvedAnswers: batch.domain.resolvedAnswers,
});

export const isPendingQuestionBatch = (batch: QuestionWorkflowBatch) =>
  batch.domain.lifecycle === "posting" ||
  batch.domain.lifecycle === "active" ||
  batch.domain.lifecycle === "submitting";

export const isTerminalQuestionBatch = (batch: QuestionWorkflowBatch) =>
  batch.domain.lifecycle === "answered" ||
  batch.domain.lifecycle === "rejected" ||
  batch.domain.lifecycle === "expired";

export const attachQuestionMessage = (
  batch: QuestionWorkflowBatch,
  message: Message,
): QuestionWorkflowBatch =>
  withQuestionBatchRuntime(batch, {
    attachment: { _tag: "attached", message },
  });

export const activateQuestionBatch = (batch: QuestionWorkflowBatch): QuestionWorkflowBatch =>
  withQuestionBatchDomain(batch, { lifecycle: "active" });

export const setQuestionBatchStatus = (
  batch: QuestionWorkflowBatch,
  lifecycle: "active" | "submitting" | "answered" | "rejected",
  resolvedAnswers?: ReadonlyArray<QuestionAnswer>,
): QuestionWorkflowBatch =>
  withQuestionBatchDomain(batch, {
    lifecycle,
    resolvedAnswers:
      resolvedAnswers ??
      (lifecycle === "rejected" ? emptyResolvedAnswers(batch.domain.request) : undefined),
  });

export const terminateQuestionBatch = (batch: QuestionWorkflowBatch): QuestionWorkflowBatch =>
  withQuestionBatchDomain(batch, { lifecycle: "expired" });

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
