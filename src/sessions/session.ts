import type { Message } from "discord.js"
import type { EventPermissionReplied, PatchPart, PermissionRequest, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2"
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
  assistantMessageId: string | null
}

export type RunProgressEvent =
  | { type: "run-started" }
  | { type: "patch-updated"; part: PatchPart }
  | { type: "text-ready"; partId: string }
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
