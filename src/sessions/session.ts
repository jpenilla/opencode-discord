import type { Message } from "discord.js"
import type { CompactionPart, EventSessionCompacted, PatchPart, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2"
import type { Deferred } from "effect/Deferred"
import type { Queue } from "effect/Queue"
import type { Ref } from "effect/Ref"

import type { TypingLoop } from "@/discord/messages.ts"
import type { SessionHandle } from "@/opencode/service.ts"

export type RunRequest = {
  message: Message
  prompt: string
  attachmentMessages: ReadonlyArray<Message>
}

export type QuestionOutcome =
  | { _tag: "none" }
  | { _tag: "user-rejected" }
  | { _tag: "ui-failure"; message: string; notified: boolean }

export type ActiveRun = {
  discordMessage: Message
  workdir: string
  attachmentMessagesById: Map<string, Message>
  progressQueue: Queue<RunProgressEvent>
  followUpQueue: Queue<RunRequest>
  acceptFollowUps: Ref<boolean>
  typing: TypingLoop
  questionOutcome: QuestionOutcome
  interruptRequested: boolean
}

export type RunProgressEvent =
  | { type: "run-finalizing"; ack: Deferred<void> }
  | { type: "patch-updated"; part: PatchPart }
  | { type: "reasoning-completed"; partId: string; text: string }
  | { type: "session-compacting"; part: CompactionPart }
  | { type: "session-compacted"; compacted: EventSessionCompacted["properties"] }
  | { type: "session-status"; status: SessionStatus }
  | { type: "tool-updated"; part: ToolPart }

export type ChannelSession = {
  channelId: string
  opencode: SessionHandle
  systemPromptAppend?: string
  rootDir: string
  workdir: string
  queue: Queue<RunRequest>
  activeRun: ActiveRun | null
}
