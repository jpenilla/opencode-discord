import type { Message } from "discord.js";

import { buildBatchedOpencodePrompt, buildQueuedFollowUpPrompt } from "@/discord/messages.ts";
import type { RunRequest } from "@/sessions/session.ts";

export type NonEmptyRunRequestBatch = readonly [RunRequest, ...RunRequest[]];
export type ActiveRunBatchKind = "initial" | "follow-up";

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
) => {
  mergeAttachmentMessages(attachmentMessagesById, requests);
  const prompts = requests.map((request) => request.prompt);
  return kind === "initial"
    ? buildBatchedOpencodePrompt(prompts)
    : buildQueuedFollowUpPrompt(prompts);
};
