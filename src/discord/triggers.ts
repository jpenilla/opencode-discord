import type { Client, Message } from "discord.js"

export type Invocation = {
  prompt: string
  replyContext?: string
}

const cleanMentionText = (content: string, botId: string) =>
  content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim()

const parsePrompt = (content: string, botId: string, triggerPhrase: string): string | null => {
  const mentionPattern = new RegExp(`<@!?${botId}>`, "i")
  if (mentionPattern.test(content)) {
    return cleanMentionText(content, botId)
  }

  const lowered = content.toLowerCase()
  const loweredTrigger = triggerPhrase.toLowerCase()
  if (!lowered.startsWith(loweredTrigger)) {
    return null
  }
  return content.slice(triggerPhrase.length).trim()
}

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

  const prompt = parsePrompt(message.content, botUser.id, triggerPhrase)
  if (prompt !== null) {
    return {
      prompt,
    }
  }

  return null
}
