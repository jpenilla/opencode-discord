import type { Message } from "discord.js"
import type { EventPermissionReplied, PatchPart, PermissionRequest, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2"
import type { Deferred } from "effect/Deferred"
import type { Queue } from "effect/Queue"

import type { SessionHandle } from "@/opencode/service.ts"

export type RunRequest = {
  message: Message
  prompt: string
}

export type ActiveRun = {
  discordMessage: Message
  workdir: string
  progressQueue: Queue<RunProgressEvent>
  assistantMessageIds: ReadonlyArray<string>
}

export type RunProgressEvent =
  | { type: "run-started" }
  | { type: "run-finalizing"; ack: Deferred<void> }
  | { type: "patch-updated"; part: PatchPart }
  | { type: "reasoning-completed"; messageId: string; partId: string; text: string }
  | { type: "session-status"; status: SessionStatus }
  | { type: "tool-updated"; part: ToolPart }
  | { type: "permission-asked"; permission: PermissionRequest }
  | { type: "permission-replied"; reply: EventPermissionReplied["properties"] }

export type ChannelSession = {
  channelId: string
  opencode: SessionHandle
  workdir: string
  queue: Queue<RunRequest>
  activeRun: ActiveRun | null
}
