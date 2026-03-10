import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { Context, Effect, Layer, Redacted } from "effect";
import type { Message as DiscordMessage } from "discord.js";

import { AppConfig } from "@/config.ts";
import {
  formatCustomEmoji,
  listUsableCustomEmojis,
  listUsableStickers,
  normalizeReactionEmoji,
} from "@/discord/assets.ts";
import {
  displaySessionPath,
  insideAliasedRoot,
  resolveSessionPath,
  sessionHomeDir,
} from "@/sandbox/session-paths.ts";
import { ChannelSessions } from "@/sessions/registry.ts";
import { getRunMessageById, resolveReactionTargetMessage } from "@/tools/run-message.ts";
import { Logger } from "@/util/logging.ts";

export type ToolBridgeShape = {
  socketPath: string;
};

export class ToolBridge extends Context.Tag("ToolBridge")<ToolBridge, ToolBridgeShape>() {}

type ToolRequest = {
  sessionID: string;
  path?: string;
  directory?: string;
  messageId?: string;
  caption?: string;
  emoji?: string;
  stickerID?: string;
};

const insideDirectory = (root: string, candidate: string) => {
  const rootPath = resolve(root);
  const candidatePath = isAbsolute(candidate) ? resolve(candidate) : resolve(rootPath, candidate);
  return insideAliasedRoot(rootPath, candidatePath);
};

const sendJson = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const sanitizeFilename = (value: string) => {
  const name = basename(value).trim();
  const safe = name
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .replaceAll(":", "_")
    .replaceAll("\0", "_");
  return safe.length > 0 ? safe : "attachment.bin";
};

const uniquePath = async (directory: string, filename: string) => {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";

  let attempt = 0;
  while (true) {
    const candidate = resolve(directory, attempt === 0 ? filename : `${base}-${attempt}${ext}`);
    const file = Bun.file(candidate);
    if (!(await file.exists())) {
      return candidate;
    }
    attempt += 1;
  }
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

        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

        if (request.method === "POST" && pathname === "/tool/send-file") {
          if (!payload.path) {
            sendJson(response, { error: "missing path" }, 400);
            return;
          }
          const sessionHome = sessionHomeDir(activeRun.workdir);
          const filePath = resolveSessionPath(activeRun.workdir, payload.path);
          if (!insideDirectory(sessionHome, filePath)) {
            sendJson(response, { error: "path outside session home" }, 403);
            return;
          }

          if (!activeRun.discordMessage.channel.isSendable()) {
            sendJson(response, { error: "channel not sendable" }, 409);
            return;
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            files: [filePath],
            allowedMentions: { parse: ["users", "roles", "everyone"] },
          });

          sendJson(response, {
            ok: true,
            message: `Sent file ${displaySessionPath(activeRun.workdir, filePath)}`,
          });
          return;
        }

        if (request.method === "POST" && pathname === "/tool/send-image") {
          if (!payload.path) {
            sendJson(response, { error: "missing path" }, 400);
            return;
          }
          const sessionHome = sessionHomeDir(activeRun.workdir);
          const imagePath = resolveSessionPath(activeRun.workdir, payload.path);
          if (!insideDirectory(sessionHome, imagePath)) {
            sendJson(response, { error: "path outside session home" }, 403);
            return;
          }

          if (!activeRun.discordMessage.channel.isSendable()) {
            sendJson(response, { error: "channel not sendable" }, 409);
            return;
          }

          await activeRun.discordMessage.channel.send({
            content: payload.caption,
            files: [imagePath],
            allowedMentions: { parse: ["users", "roles", "everyone"] },
          });

          sendJson(response, {
            ok: true,
            message: `Sent image ${displaySessionPath(activeRun.workdir, imagePath)}`,
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
              { error: `messageId is not available in this channel: ${payload.messageId}` },
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

        if (request.method === "POST" && pathname === "/tool/download-attachments") {
          if (!payload.messageId) {
            sendJson(response, { error: "missing messageId" }, 400);
            return;
          }

          const targetDirectory = resolveSessionPath(activeRun.workdir, payload.directory ?? ".");
          if (!insideDirectory(sessionHomeDir(activeRun.workdir), targetDirectory)) {
            sendJson(response, { error: "directory outside session home" }, 403);
            return;
          }

          const targetMessage = getRunMessageById(activeRun, payload.messageId);
          if (!targetMessage) {
            sendJson(
              response,
              { error: `messageId is not available in the current run: ${payload.messageId}` },
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

          await mkdir(targetDirectory, { recursive: true });

          const downloaded: Array<{
            savedPath: string;
            originalName: string;
            messageId: string;
          }> = [];
          for (const { attachment, messageId } of attachments) {
            const download = await fetch(attachment.url);
            if (!download.ok) {
              sendJson(
                response,
                { error: `failed to download attachment: ${attachment.url}` },
                502,
              );
              return;
            }

            const arrayBuffer = await download.arrayBuffer();
            const filename = sanitizeFilename(attachment.name ?? attachment.id);
            const destination = await uniquePath(targetDirectory, filename);
            await writeFile(destination, new Uint8Array(arrayBuffer));
            downloaded.push({
              savedPath: displaySessionPath(activeRun.workdir, destination),
              originalName: attachment.name ?? attachment.id,
              messageId,
            });
          }

          sendJson(response, {
            ok: true,
            message: [
              `Downloaded ${downloaded.length} attachment${downloaded.length === 1 ? "" : "s"}:`,
              ...downloaded.map(
                ({ savedPath, originalName, messageId }) =>
                  `- \`${savedPath}\` from Discord message \`${messageId}\` (\`${originalName}\`)`,
              ),
            ].join("\n"),
          });
          return;
        }

        sendJson(response, { error: "not found" }, 404);
      } catch (error) {
        await Effect.runPromise(
          logger.error("tool bridge request failed", {
            error: String(error),
          }),
        );
        sendJson(response, { error: "internal error" }, 500);
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
