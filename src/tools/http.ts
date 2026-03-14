import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { mkdir, rm } from "node:fs/promises";

import { Context, Effect, Layer, Redacted } from "effect";
import { AttachmentBuilder, type Message as DiscordMessage } from "discord.js";

import { AppConfig } from "@/config.ts";
import {
  formatCustomEmoji,
  listUsableCustomEmojis,
  listUsableStickers,
  normalizeReactionEmoji,
} from "@/discord/assets.ts";
import { formatAttachmentList } from "@/tools/attachments.ts";
import { ChannelSessions } from "@/sessions/registry.ts";
import { classifyToolBridgeFailure } from "@/tools/bridge-error.ts";
import { getRunMessageById, resolveReactionTargetMessage } from "@/tools/run-message.ts";
import { Logger } from "@/util/logging.ts";

export type ToolBridgeShape = {
  socketPath: string;
};

export class ToolBridge extends Context.Tag("ToolBridge")<ToolBridge, ToolBridgeShape>() {}

type ToolRequest = {
  sessionID: string;
  messageId?: string;
  caption?: string;
  filename?: string;
  displayPath?: string;
  dataBase64?: string;
  emoji?: string;
  stickerID?: string;
};

const sendJson = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const readJsonBody = async (request: IncomingMessage): Promise<ToolRequest | undefined> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return JSON.parse(raw) as ToolRequest;
};

const formatEmojiList = (message: DiscordMessage) => {
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

const formatStickerList = async (message: DiscordMessage) => {
  const stickers = await listUsableStickers(message);
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
};

export const ToolBridgeLive = Layer.scoped(
  ToolBridge,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const logger = yield* Logger;
    const sessions = yield* ChannelSessions;

    yield* Effect.promise(() => mkdir(dirname(config.toolBridgeSocketPath), { recursive: true }));
    yield* Effect.promise(() => rm(config.toolBridgeSocketPath, { force: true }));

    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      let operation = "tool bridge request";
      try {
        if (
          request.headers["x-opencode-discord-token"] !== Redacted.value(config.toolBridgeToken)
        ) {
          sendJson(response, { error: "unauthorized" }, 401);
          return;
        }

        let payload: ToolRequest | undefined;
        try {
          payload = await readJsonBody(request);
        } catch {
          sendJson(response, { error: "invalid json" }, 400);
          return;
        }

        if (!payload?.sessionID) {
          sendJson(response, { error: "missing sessionID" }, 400);
          return;
        }

        const activeRun = await Effect.runPromise(
          sessions.getActiveRunBySessionId(payload.sessionID),
        );
        if (!activeRun) {
          sendJson(response, { error: "no active run for session" }, 409);
          return;
        }

        if (request.method === "POST" && pathname === "/tool/send-file") {
          operation = "file upload";
          if (!payload.filename || typeof payload.dataBase64 !== "string") {
            sendJson(response, { error: "missing upload data" }, 400);
            return;
          }
          const file = new AttachmentBuilder(Buffer.from(payload.dataBase64, "base64"), {
            name: payload.filename,
          });

          if (!activeRun.discordMessage.channel.isSendable()) {
            sendJson(response, { error: "channel not sendable" }, 409);
            return;
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            files: [file],
            allowedMentions: { parse: ["users", "roles", "everyone"] },
          });

          sendJson(response, {
            ok: true,
            message: `Sent file ${payload.displayPath ?? payload.filename}`,
          });
          return;
        }

        if (request.method === "POST" && pathname === "/tool/send-image") {
          operation = "image upload";
          if (!payload.filename || typeof payload.dataBase64 !== "string") {
            sendJson(response, { error: "missing upload data" }, 400);
            return;
          }
          const image = new AttachmentBuilder(Buffer.from(payload.dataBase64, "base64"), {
            name: payload.filename,
          });

          if (!activeRun.discordMessage.channel.isSendable()) {
            sendJson(response, { error: "channel not sendable" }, 409);
            return;
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            files: [image],
            allowedMentions: { parse: ["users", "roles", "everyone"] },
          });

          sendJson(response, {
            ok: true,
            message: `Sent image ${payload.displayPath ?? payload.filename}`,
          });
          return;
        }

        if (request.method === "POST" && pathname === "/tool/list-custom-emojis") {
          sendJson(response, {
            ok: true,
            message: formatEmojiList(activeRun.discordMessage),
          });
          return;
        }

        if (request.method === "POST" && pathname === "/tool/list-stickers") {
          sendJson(response, {
            ok: true,
            message: await formatStickerList(activeRun.discordMessage),
          });
          return;
        }

        if (request.method === "POST" && pathname === "/tool/send-sticker") {
          operation = "sticker send";
          if (!payload.stickerID) {
            sendJson(response, { error: "missing stickerID" }, 400);
            return;
          }

          const sticker = (await listUsableStickers(activeRun.discordMessage)).find(
            (candidate) => candidate.sticker.id === payload.stickerID,
          );
          if (!sticker) {
            sendJson(response, { error: "sticker is not available in this context" }, 403);
            return;
          }

          if (!activeRun.discordMessage.channel.isSendable()) {
            sendJson(response, { error: "channel not sendable" }, 409);
            return;
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            stickers: [sticker.sticker.id],
            allowedMentions: { parse: ["users", "roles", "everyone"] },
          });

          sendJson(response, {
            ok: true,
            message: `Sent sticker ${sticker.sticker.name} (${sticker.sticker.id})`,
          });
          return;
        }

        if (request.method === "POST" && pathname === "/tool/react") {
          operation = "reaction";
          if (!payload.messageId) {
            sendJson(response, { error: "missing messageId" }, 400);
            return;
          }
          if (!payload.emoji) {
            sendJson(response, { error: "missing emoji" }, 400);
            return;
          }
          const targetMessage = await Effect.runPromise(
            resolveReactionTargetMessage(activeRun, payload.messageId),
          );
          if (!targetMessage) {
            sendJson(
              response,
              {
                error: `messageId is not available in this channel: ${payload.messageId}`,
              },
              404,
            );
            return;
          }
          const emoji = normalizeReactionEmoji(targetMessage, payload.emoji);
          if (!emoji) {
            sendJson(response, { error: "invalid or unavailable emoji" }, 400);
            return;
          }
          await targetMessage.react(emoji);
          sendJson(response, {
            ok: true,
            message: `Added reaction ${emoji} to Discord message ${targetMessage.id}`,
          });
          return;
        }

        if (request.method === "POST" && pathname === "/tool/list-attachments") {
          operation = "attachment listing";
          if (!payload.messageId) {
            sendJson(response, { error: "missing messageId" }, 400);
            return;
          }

          const targetMessage = getRunMessageById(activeRun, payload.messageId);
          if (!targetMessage) {
            sendJson(
              response,
              {
                error: `messageId is not available in the current run: ${payload.messageId}`,
              },
              404,
            );
            return;
          }

          const attachments = [...targetMessage.attachments.values()].map((attachment) => ({
            attachment,
            messageId: targetMessage.id,
          }));
          if (attachments.length === 0) {
            sendJson(
              response,
              {
                error: `no attachments on Discord message ${payload.messageId}`,
              },
              409,
            );
            return;
          }

          sendJson(response, {
            ok: true,
            message: JSON.stringify(
              {
                description: `Attachments on Discord message ${payload.messageId}`,
                list: formatAttachmentList(
                  attachments.map(({ attachment }) => ({
                    attachmentId: attachment.id,
                    name: attachment.name ?? attachment.id,
                    contentType: attachment.contentType,
                    size: attachment.size,
                    url: attachment.url,
                  })),
                ),
              },
              null,
              2,
            ),
          });
          return;
        }

        sendJson(response, { error: "not found" }, 404);
      } catch (error) {
        const failure = classifyToolBridgeFailure(operation, error);
        await Effect.runPromise(
          logger.error("tool bridge request failed", {
            pathname,
            operation,
            kind: failure.kind,
            error: failure.error,
            cause: String(error),
          }),
        );
        sendJson(
          response,
          {
            error: failure.error,
            kind: failure.kind,
          },
          failure.status,
        );
      }
    });

    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };

          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(config.toolBridgeSocketPath);
        }),
    );

    yield* logger.info("started tool bridge", {
      socketPath: config.toolBridgeSocketPath,
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }),
        ).pipe(Effect.ignore);
        yield* Effect.promise(() => rm(config.toolBridgeSocketPath, { force: true })).pipe(
          Effect.ignore,
        );
      }),
    );

    return {
      socketPath: config.toolBridgeSocketPath,
    } satisfies ToolBridgeShape;
  }),
);
