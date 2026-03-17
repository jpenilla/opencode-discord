import { Effect } from "effect";
import type { Message } from "discord.js";

export const resolveReferencedMessage = (
  message: Message,
): Effect.Effect<Message | null, never> => {
  if (!message.reference?.messageId) {
    return Effect.succeed(null);
  }

  return Effect.tryPromise({
    try: () => message.fetchReference(),
    catch: () => null,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
};

export const collectAttachmentMessages = (
  message: Message,
): Effect.Effect<ReadonlyArray<Message>, never> =>
  resolveReferencedMessage(message).pipe(
    Effect.map((referenced) => {
      const attachmentMessages = new Map<string, Message>([[message.id, message]]);
      if (referenced) {
        attachmentMessages.set(referenced.id, referenced);
      }
      return [...attachmentMessages.values()];
    }),
  );
