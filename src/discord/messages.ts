import type { APIEmbedField, Attachment, Embed, Message, SendableChannels } from "discord.js"
import { MessageFlags } from "discord.js"

import { splitDiscordMessage } from "@/discord/formatting.ts"
import { normalizeOutgoingMentions } from "@/discord/mentions.ts"

const DISCORD_MESSAGE_LIMIT = 2000

const summarizeField = (field: APIEmbedField | Embed["fields"][number]) => `${field.name}: ${field.value}`

export const summarizeEmbeds = (message: Message) => {
  if (message.embeds.length === 0) {
    return "None"
  }

  return message.embeds
    .map((embed, index) => {
      const parts: Array<string> = [`Embed ${index + 1}`]
      if (embed.title) parts.push(`title=${embed.title}`)
      if (embed.description) parts.push(`description=${embed.description}`)
      if (embed.url) parts.push(`url=${embed.url}`)
      if (embed.fields.length > 0) parts.push(`fields=${embed.fields.map(summarizeField).join("; ")}`)
      return `- ${parts.join(" | ")}`
    })
    .join("\n")
}

const summarizeAttachment = (attachment: Attachment) => {
  const parts = [attachment.name ?? attachment.id, `${attachment.size} bytes`]
  if (attachment.contentType) parts.push(attachment.contentType)
  parts.push(attachment.url)
  return `- ${parts.join(" | ")}`
}

export const summarizeAttachments = (message: Message) => {
  if (message.attachments.size === 0) {
    return "None"
  }
  return [...message.attachments.values()].map(summarizeAttachment).join("\n")
}

export const buildOpencodePrompt = (input: {
  userTag: string
  content: string
  replyContext?: string
  attachmentSummary: string
  embedSummary: string
}) => {
  const sections = [
    `Discord user: ${input.userTag}`,
    "Message:",
    input.content.trim() || "(empty message)",
  ]

  if (input.replyContext) {
    sections.push("", "Replied bot message:", input.replyContext)
  }

  sections.push("", "Attachment metadata:", input.attachmentSummary)
  sections.push("", "Embed summary:", input.embedSummary)

  return sections.join("\n")
}

const wrapDiscordPrompts = (heading: string, prompts: ReadonlyArray<string>) =>
  [
    heading,
    ...prompts.map((prompt, index) => [`<discord-message index="${index + 1}">`, prompt, "</discord-message>"].join("\n")),
  ].join("\n\n")

export const buildBatchedOpencodePrompt = (prompts: ReadonlyArray<string>) => {
  if (prompts.length === 1) {
    return prompts[0] ?? ""
  }

  return wrapDiscordPrompts(
    "Multiple Discord messages arrived before you responded. Read all of them and address them together in order.",
    prompts,
  )
}

export const buildQueuedFollowUpPrompt = (prompts: ReadonlyArray<string>) =>
  wrapDiscordPrompts(
    "Additional Discord messages arrived while you were working. Read all of them, address them, and continue the task.",
    prompts,
  )

export const sendFinalResponse = async (input: {
  message: Message
  text: string
}) => {
  const safeText = input.text.length > 0 ? normalizeOutgoingMentions(input.message, input.text) : "(no response content)"
  const chunks = splitDiscordMessage(safeText)

  for (const [index, chunk] of chunks.entries()) {
    if (index === 0) {
      await input.message.reply({
        content: chunk.slice(0, DISCORD_MESSAGE_LIMIT),
        allowedMentions: { repliedUser: true, parse: ["users", "roles", "everyone"] },
      })
      continue
    }

    if (!input.message.channel.isSendable()) {
      continue
    }

    await (input.message.channel as SendableChannels).send({
      content: chunk.slice(0, DISCORD_MESSAGE_LIMIT),
      allowedMentions: { parse: ["users", "roles", "everyone"] },
    })
  }
}

export const sendProgressUpdate = async (input: {
  message: Message
  text: string
}) => {
  const safeText = normalizeOutgoingMentions(input.message, input.text).trim()
  if (!safeText) {
    return
  }

  const chunks = splitDiscordMessage(safeText)
  if (!input.message.channel.isSendable()) {
    return
  }

  for (const chunk of chunks) {
    await (input.message.channel as SendableChannels).send({
      content: chunk.slice(0, DISCORD_MESSAGE_LIMIT),
      allowedMentions: { parse: ["users", "roles", "everyone"] },
      flags: MessageFlags.SuppressNotifications,
    })
  }
}

export const startTypingLoop = (channel: Message["channel"]) => {
  const TYPING_REFRESH_MS = 8_000
  let stopped = false
  let sending = false

  const tick = async () => {
    if (stopped || sending || !channel.isSendable()) {
      return
    }

    sending = true
    try {
      await channel.sendTyping()
    } catch {
      // Keep retrying during the run; transient API/gateway issues should not permanently stop typing.
    } finally {
      sending = false
    }
  }

  void tick()
  const interval = setInterval(() => {
    void tick()
  }, TYPING_REFRESH_MS)

  return () => {
    stopped = true
    clearInterval(interval)
  }
}
