import type { Message } from "discord.js";
import { Effect, Queue } from "effect";

import { buildBatchedOpencodePrompt, buildQueuedFollowUpPrompt } from "@/discord/messages.ts";
import type { AdmittedPromptContext, ActiveRunBatchKind } from "@/sessions/run/prompt-context.ts";
import type { RunRequest } from "@/sessions/session.ts";

export type NonEmptyRunRequestBatch = readonly [RunRequest, ...RunRequest[]];
export const maxQueuedRunBatchSize = 65;

export const takeQueuedRunBatch = (
  queue: Queue.Queue<RunRequest>,
): Effect.Effect<NonEmptyRunRequestBatch> =>
  Queue.takeBetween(queue, 1, maxQueuedRunBatchSize).pipe(
    Effect.map((requests) => [requests[0]!, ...requests.slice(1)] as NonEmptyRunRequestBatch),
  );

export const mergeAttachmentMessages = (
  target: Map<string, Message>,
  requests: ReadonlyArray<RunRequest>,
) => {
  for (const request of requests) {
    for (const attachmentMessage of request.attachmentMessages) {
      target.set(attachmentMessage.id, attachmentMessage);
    }
  }
};

export const admitRequestBatchToActiveRun = (
  attachmentMessagesById: Map<string, Message>,
  requests: NonEmptyRunRequestBatch,
  kind: ActiveRunBatchKind,
): AdmittedPromptContext => {
  mergeAttachmentMessages(attachmentMessagesById, requests);
  const prompts = requests.map((request) => request.prompt);
  return {
    kind,
    prompt:
      kind === "initial" ? buildBatchedOpencodePrompt(prompts) : buildQueuedFollowUpPrompt(prompts),
    replyTargetMessage:
      kind === "initial" ? requests[0]!.message : requests[requests.length - 1]!.message,
    requestMessages: requests.map((request) => request.message),
  };
};
