import type { Message } from "discord.js";
import { Effect } from "effect";
import * as v from "valibot";

import { formatCustomEmoji, listUsableCustomEmojis, listUsableStickers } from "@/discord/assets.ts";
import { ToolBridgeResponseError } from "@/tools/bridge/errors.ts";
import { requireSendableChannel, sendBridgeMessage } from "@/tools/bridge/handlers/shared.ts";
import type { ToolBridgeHandlerContext } from "@/tools/bridge/routes.ts";
import { nonEmptyString } from "@/tools/bridge/validation.ts";

export const sendStickerPayloadSchema = v.object({
  stickerID: nonEmptyString,
  caption: v.optional(v.string()),
});

export type SendStickerPayload = v.InferOutput<typeof sendStickerPayloadSchema>;

const formatEmojiList = (message: Message) => {
  const emojis = listUsableCustomEmojis(message);
  if (emojis.length === 0) {
    return "No custom emojis are available in this context.";
  }

  return [
    "Custom emojis available in this context:",
    ...emojis.map((emoji) => {
      const reactionInput = `${emoji.animated ? "a:" : ""}${emoji.name}:${emoji.id}`;
      return `- ${formatCustomEmoji(emoji)} \`:${emoji.name}:\` react=\`${reactionInput}\` guild=\`${emoji.guild.name}\``;
    }),
  ].join("\n");
};

const formatStickerList = (message: Message) => {
  return listContextStickers(message).pipe(
    Effect.map((stickers) => {
      if (stickers.length === 0) {
        return "No stickers are available in this context.";
      }

      return [
        "Stickers available in this context:",
        ...stickers.map((sticker) => {
          const tags = sticker.sticker.tags ? ` tags=\`${sticker.sticker.tags}\`` : "";
          const source =
            sticker.guildName !== null
              ? ` guild=\`${sticker.guildName}\``
              : ` pack=\`${sticker.packName ?? "unknown"}\``;
          return `- \`${sticker.sticker.id}\` \`${sticker.sticker.name}\`${source}${tags}`;
        }),
      ].join("\n");
    }),
  );
};

const listContextStickers = (message: Message) =>
  Effect.tryPromise(() => listUsableStickers(message));

export const handleListCustomEmojis = (context: ToolBridgeHandlerContext<void>) => {
  return Effect.succeed(formatEmojiList(context.activeRun.discordMessage));
};

export const handleListStickers = (context: ToolBridgeHandlerContext<void>) => {
  return formatStickerList(context.activeRun.discordMessage);
};

export const handleSendSticker = (context: ToolBridgeHandlerContext<SendStickerPayload>) => {
  return Effect.gen(function* () {
    const { caption, stickerID } = context.payload;
    const stickers = yield* listContextStickers(context.activeRun.discordMessage);
    const sticker = stickers.find((candidate) => candidate.sticker.id === stickerID);
    if (!sticker) {
      return yield* Effect.fail(
        new ToolBridgeResponseError(403, "sticker is not available in this context"),
      );
    }

    const channel = yield* requireSendableChannel(context.activeRun);
    yield* sendBridgeMessage(channel, {
      content: caption,
      stickers: [sticker.sticker.id],
    });

    return `Sent sticker ${sticker.sticker.name} (${sticker.sticker.id})`;
  });
};
