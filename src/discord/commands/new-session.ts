import { Effect } from "effect";

import { CommandContext } from "@/discord/commands/command-context.ts";
import { InfoCards } from "@/discord/info-cards.ts";
import { decideNewSessionEntry, NEW_SESSION_BUSY_MESSAGE } from "@/sessions/command-lifecycle.ts";
import { SessionControl } from "@/sessions/session-control.ts";
import { formatError } from "@/util/errors.ts";
import { Logger } from "@/util/logging.ts";
import { defineGuildCommand } from "./definition.ts";

export const newSessionCommand = defineGuildCommand({
  name: "new-session",
  description: "Start a fresh OpenCode session in this channel on the next message",
  execute: Effect.gen(function* () {
    const context = yield* CommandContext;
    const sessionControl = yield* SessionControl;
    const infoCards = yield* InfoCards;
    const logger = yield* Logger;

    const channelActivity =
      context.inGuildTextChannel && context.guildTextChannel
        ? yield* sessionControl.readLoadedChannelActivity(context.channelId)
        : ({ type: "missing" } as const);
    const entry = decideNewSessionEntry({
      inGuildTextChannel: context.inGuildTextChannel && Boolean(context.guildTextChannel),
      channelActivity,
    });
    if (entry.type === "reject") {
      yield* context.complete(entry.message);
      return;
    }

    yield* context.ack();
    const invalidated = yield* sessionControl.invalidate(
      context.channelId,
      "requested a fresh session via /new-session",
    );
    if (!invalidated) {
      const refreshedChannelActivity =
        context.inGuildTextChannel && context.guildTextChannel
          ? yield* sessionControl.readLoadedChannelActivity(context.channelId)
          : ({ type: "missing" } as const);
      const refreshedEntry = decideNewSessionEntry({
        inGuildTextChannel: context.inGuildTextChannel && Boolean(context.guildTextChannel),
        channelActivity: refreshedChannelActivity,
      });
      yield* context.complete(
        refreshedEntry.type === "reject" ? refreshedEntry.message : NEW_SESSION_BUSY_MESSAGE,
      );
      return;
    }
    yield* infoCards
      .upsert({
        channel: context.guildTextChannel!,
        existingCard: null,
        title: "🆕 Fresh session ready",
        body: "The next triggered message in this channel will start a new OpenCode session with fresh chat history. Workspace files were left in place.",
      })
      .pipe(
        Effect.catch((error) =>
          logger.warn("failed to post fresh session info card", {
            channelId: context.channelId,
            error: formatError(error),
          }),
        ),
        Effect.ignore,
      );
    yield* context.complete(
      "Cleared this channel's current OpenCode session. The next triggered message here will start a new session with fresh chat history. Workspace files were left in place.",
    );
  }),
});
