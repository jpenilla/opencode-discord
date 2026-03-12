import type { Client, Message } from "discord.js";

export type Invocation = {
  prompt: string;
};

const cleanMentionText = (content: string, botId: string) =>
  content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();

const parsePrompt = (content: string, botId: string, triggerPhrase: string): string | null => {
  const mentionPattern = new RegExp(`<@!?${botId}>`, "i");
  if (mentionPattern.test(content)) {
    return cleanMentionText(content, botId);
  }

  const lowered = content.toLowerCase();
  const loweredTrigger = triggerPhrase.toLowerCase();
  if (!lowered.startsWith(loweredTrigger)) {
    return null;
  }
  return content.slice(triggerPhrase.length).trim();
};

export const detectInvocation = async (input: {
  client: Client;
  message: Message;
  triggerPhrase: string;
  ignoreOtherBotTriggers: boolean;
}): Promise<Invocation | null> => {
  const { client, message, triggerPhrase, ignoreOtherBotTriggers } = input;
  const botUser = client.user;
  if (!botUser) {
    return null;
  }
  if (message.author.id === botUser.id) {
    return null;
  }
  if (ignoreOtherBotTriggers && message.author.bot) {
    return null;
  }

  if (message.reference?.messageId) {
    try {
      const referenced = await message.fetchReference();
      if (message.mentions.repliedUser?.id === botUser.id && referenced.author.id === botUser.id) {
        return {
          prompt: message.content.trim(),
        };
      }
    } catch {
      // ignore unavailable references
    }
  }

  const prompt = parsePrompt(message.content, botUser.id, triggerPhrase);
  if (prompt !== null) {
    return {
      prompt,
    };
  }

  return null;
};
