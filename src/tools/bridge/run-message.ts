import type { Message as DiscordMessage } from "discord.js";
import { Effect } from "effect";

type RunMessageSource = {
  originMessage: DiscordMessage;
  attachmentMessagesById: Map<string, DiscordMessage>;
};

export const getRunMessageById = (source: RunMessageSource, messageId: string) =>
  source.attachmentMessagesById.get(messageId) ??
  (source.originMessage.id === messageId ? source.originMessage : null);

export const resolveReactionTargetMessage = (
  source: RunMessageSource,
  messageId: string,
): Effect.Effect<DiscordMessage | null> => {
  const known = getRunMessageById(source, messageId);
  if (known) {
    return Effect.succeed(known);
  }

  const channel = source.originMessage.channel;
  if (
    !("messages" in channel) ||
    !channel.messages ||
    typeof channel.messages.fetch !== "function"
  ) {
    return Effect.succeed(null);
  }

  return Effect.tryPromise({
    try: () => channel.messages.fetch(messageId),
    catch: () => null,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
};
