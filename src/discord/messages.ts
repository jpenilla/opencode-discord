import type { APIEmbedField, Attachment, Embed, Message, SendableChannels } from "discord.js"

const DISCORD_MESSAGE_LIMIT = 2000
const SAFE_DISCORD_MESSAGE_LIMIT = 1900

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

export const splitDiscordMessage = (text: string, maxLength = SAFE_DISCORD_MESSAGE_LIMIT): Array<string> => {
  if (text.length <= maxLength) {
    return [text]
  }

  const chunks: Array<string> = []
  let remaining = text

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength)
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = remaining.lastIndexOf(" ", maxLength)
    }
    if (splitAt <= 0) {
      splitAt = maxLength
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining.length > 0) {
    chunks.push(remaining)
  }

  return chunks
}

export const sendFinalResponse = async (input: {
  message: Message
  text: string
}) => {
  const safeText = input.text.length > 0 ? input.text : "(no response content)"
  const chunks = splitDiscordMessage(safeText, SAFE_DISCORD_MESSAGE_LIMIT)

  for (const [index, chunk] of chunks.entries()) {
    if (index === 0) {
      await input.message.reply({
        content: chunk.slice(0, DISCORD_MESSAGE_LIMIT),
        allowedMentions: { repliedUser: false, parse: [] },
      })
      continue
    }

    if (!input.message.channel.isSendable()) {
      continue
    }

    await (input.message.channel as SendableChannels).send({
      content: chunk.slice(0, DISCORD_MESSAGE_LIMIT),
      allowedMentions: { parse: [] },
    })
  }
}

export const startTypingLoop = (channel: Message["channel"]) => {
  let active = true

  const tick = async () => {
    while (active) {
      try {
        if (!channel.isSendable()) {
          return
        }
        await channel.sendTyping()
      } catch {
        return
      }
      await Bun.sleep(7_000)
    }
  }

  void tick()

  return () => {
    active = false
  }
}
