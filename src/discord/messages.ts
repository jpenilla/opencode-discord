import type { Message, SendableChannels } from "discord.js";
import { MessageFlags } from "discord.js";

import { splitDiscordMessage } from "@/discord/formatting.ts";
import { normalizeOutgoingMentions } from "@/discord/mentions.ts";

const DISCORD_MESSAGE_LIMIT = 2000;

export const summarizeEmbeds = (message: Message) => {
  if (message.embeds.length === 0) {
    return "None";
  }

  return message.embeds
    .map((embed, index) => {
      const parts: Array<string> = [`Embed ${index + 1}`];
      if (embed.title) parts.push(`title=${embed.title}`);
      if (embed.description) parts.push(`description=${embed.description}`);
      if (embed.url) parts.push(`url=${embed.url}`);
      if (embed.fields.length > 0)
        parts.push(
          `fields=${embed.fields.map((field) => `${field.name}: ${field.value}`).join("; ")}`,
        );
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
};

type PromptMessageContext = {
  userTag: string;
  messageId: string;
  content: string;
  attachmentContext: string;
  embedSummary: string;
};

export const promptMessageContext = (
  message: Message,
  contentOverride?: string,
): PromptMessageContext => ({
  userTag: message.author.tag,
  messageId: message.id,
  content: (contentOverride ?? message.content).trim() || "(empty message)",
  attachmentContext: message.attachments.size > 0 ? "yes" : "no",
  embedSummary: summarizeEmbeds(message),
});

const appendPromptMessageContext = (
  sections: string[],
  context: PromptMessageContext,
  prefix = "",
) => {
  sections.push(`${prefix}Discord user: ${context.userTag}`);
  sections.push(`${prefix}Discord message ID: ${context.messageId}`);
  sections.push(`${prefix}Message:`);
  sections.push(context.content);
  sections.push("", `${prefix}Attachments:`, context.attachmentContext);
  sections.push("", `${prefix}Embed summary:`, context.embedSummary);
};

export const buildOpencodePrompt = (input: {
  message: PromptMessageContext;
  referencedMessage?: PromptMessageContext;
}) => {
  const sections: string[] = [];
  appendPromptMessageContext(sections, input.message);

  if (input.referencedMessage) {
    sections.push("");
    appendPromptMessageContext(sections, input.referencedMessage, "Referenced ");
  }

  return sections.join("\n");
};

const wrapDiscordPrompts = (heading: string, prompts: ReadonlyArray<string>) =>
  [
    heading,
    ...prompts.map((prompt, index) =>
      [`<discord-message index="${index + 1}">`, prompt, "</discord-message>"].join("\n"),
    ),
  ].join("\n\n");

const splitOutgoingText = (
  message: Message | null,
  text: string,
  options?: {
    emptyFallback?: string;
    trim?: boolean;
  },
) => {
  let normalized = message ? normalizeOutgoingMentions(message, text) : text;
  if (options?.trim) {
    normalized = normalized.trim();
  }
  if (!normalized) {
    normalized = options?.emptyFallback ?? "";
  }
  if (!normalized) {
    return [];
  }
  return splitDiscordMessage(normalized);
};

const sendChunks = async (
  chunks: ReadonlyArray<string>,
  send: (chunk: string, index: number) => Promise<void>,
) => {
  for (const [index, chunk] of chunks.entries()) {
    await send(chunk, index);
  }
};

const sendChannelChunks = (
  channel: SendableChannels,
  chunks: ReadonlyArray<string>,
  options?: { flags?: MessageFlags.SuppressNotifications },
) =>
  sendChunks(chunks, async (chunk) => {
    await channel.send({
      content: chunk.slice(0, DISCORD_MESSAGE_LIMIT),
      allowedMentions: { parse: ["users", "roles", "everyone"] },
      flags: options?.flags,
    });
  });

export const buildBatchedOpencodePrompt = (prompts: ReadonlyArray<string>) => {
  if (prompts.length === 1) {
    return prompts[0] ?? "";
  }

  return wrapDiscordPrompts(
    "Multiple Discord messages arrived before you responded. Read all of them and address them together in order.",
    prompts,
  );
};

export const buildQueuedFollowUpPrompt = (prompts: ReadonlyArray<string>) =>
  wrapDiscordPrompts(
    "Additional Discord messages arrived while you were working. Read all of them, address them, and continue the task.",
    prompts,
  );

export const sendFinalResponse = async (input: { message: Message; text: string }) => {
  const chunks = splitOutgoingText(input.message, input.text, {
    emptyFallback: "(no response content)",
  });

  const [firstChunk, ...remainingChunks] = chunks;
  if (!firstChunk) {
    return;
  }

  await input.message.reply({
    content: firstChunk.slice(0, DISCORD_MESSAGE_LIMIT),
    allowedMentions: { repliedUser: true, parse: ["users", "roles", "everyone"] },
  });

  if (!input.message.channel.isSendable() || remainingChunks.length === 0) {
    return;
  }

  await sendChannelChunks(input.message.channel as SendableChannels, remainingChunks);
};

export const sendProgressUpdate = async (message: Message, text: string) => {
  if (!message.channel.isSendable()) {
    return;
  }

  const chunks = splitOutgoingText(message, text, { trim: true });
  if (chunks.length === 0) {
    return;
  }

  await sendChannelChunks(message.channel as SendableChannels, chunks, {
    flags: MessageFlags.SuppressNotifications,
  });
};

export const sendChannelProgressUpdate = async (input: {
  channel: SendableChannels;
  mentionContext?: Message | null;
  text: string;
}) => {
  const chunks = splitOutgoingText(input.mentionContext ?? null, input.text, { trim: true });
  if (chunks.length === 0) {
    return;
  }

  await sendChannelChunks(input.channel, chunks, {
    flags: MessageFlags.SuppressNotifications,
  });
};

export type TypingLoop = {
  pause: () => Promise<void>;
  resume: () => void;
  stop: () => Promise<void>;
};

export const startTypingLoop = (channel: Message["channel"]): TypingLoop => {
  const TYPING_REFRESH_MS = 9_000;
  let stopped = false;
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const clearTimer = () => {
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (delay: number) => {
    clearTimer();
    if (stopped || paused) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delay);
  };

  const tick = async () => {
    if (stopped || paused || inFlight || !channel.isSendable()) {
      return;
    }

    const send = (async () => {
      try {
        await channel.sendTyping();
      } catch {
        // Keep retrying during the run; transient API/gateway issues should not permanently stop typing.
      }
    })();

    inFlight = send;
    try {
      await send;
    } finally {
      if (inFlight === send) {
        inFlight = null;
      }
    }

    schedule(TYPING_REFRESH_MS);
  };

  void tick();

  return {
    pause: async () => {
      paused = true;
      clearTimer();
      if (inFlight) {
        await inFlight;
      }
    },
    resume: () => {
      if (stopped || !paused) {
        return;
      }
      paused = false;
      void tick();
    },
    stop: async () => {
      if (stopPromise) {
        return await stopPromise;
      }

      stopped = true;
      paused = true;
      clearTimer();
      stopPromise = inFlight ?? Promise.resolve();
      await stopPromise;
    },
  };
};
