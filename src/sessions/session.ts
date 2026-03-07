import type { Message } from "discord.js"
import type { Queue } from "effect/Queue"

import type { SessionHandle } from "../opencode/service.ts"

export type RunRequest = {
  message: Message
  prompt: string
}

export type ActiveRun = {
  discordMessage: Message
  workdir: string
}

export type ChannelSession = {
  channelId: string
  opencode: SessionHandle
  workdir: string
  queue: Queue<RunRequest>
  activeRun: ActiveRun | null
}
