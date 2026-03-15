import type { Message } from "discord.js";

export type ActiveRunBatchKind = "initial" | "follow-up";

export type AdmittedPromptContext = {
  kind: ActiveRunBatchKind;
  prompt: string;
  replyTargetMessage: Message;
  requestMessages: ReadonlyArray<Message>;
};
