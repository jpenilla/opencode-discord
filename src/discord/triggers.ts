import type { Client, Message } from "discord.js"

export type Invocation = {
  prompt: string
  replyContext?: string
}

const cleanMentionText = (content: string, botId: string) =>
  content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim()

export const detectInvocation = async (input: {
  client: Client
  message: Message
  triggerPhrase: string
}): Promise<Invocation | null> => {
  const { client, message, triggerPhrase } = input
  const botUser = client.user
  if (!botUser) {
    return null
  }

  let replyContext: string | undefined
  if (message.reference?.messageId) {
    try {
      const referenced = await message.fetchReference()
      if (referenced.author.id === botUser.id) {
        replyContext = referenced.content.trim() || "(no text content)"
        return {
          prompt: message.content.trim(),
          replyContext,
        }
      }
    } catch {
      // ignore unavailable references
    }
  }

  if (message.mentions.users.has(botUser.id)) {
    const prompt = cleanMentionText(message.content, botUser.id)
    return {
      prompt,
    }
  }

  const lowered = message.content.toLowerCase()
  const loweredTrigger = triggerPhrase.toLowerCase()
  if (lowered.startsWith(loweredTrigger)) {
    return {
      prompt: message.content.slice(triggerPhrase.length).trim(),
    }
  }

  return null
}
