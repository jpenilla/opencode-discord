import { Effect } from "effect";

import { CommandContext } from "@/discord/commands/command-context.ts";
import { InfoCards } from "@/discord/info-cards.ts";
import { IdleCompactionWorkflow } from "@/sessions/idle-compaction-workflow.ts";
import { GUILD_TEXT_COMMAND_ONLY_MESSAGE } from "@/sessions/command-lifecycle.ts";
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
    const idleCompaction = yield* IdleCompactionWorkflow;
    const infoCards = yield* InfoCards;
    const logger = yield* Logger;

    if (!context.inGuildTextChannel || !context.guildTextChannel) {
      yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
      return true;
    }

    const session = yield* sessionControl.getLoaded(context.channelId);
    if (session?.activeRun) {
      yield* context.complete(
        "OpenCode is busy in this channel right now. Wait for the current run to finish or use /interrupt before starting a fresh session.",
      );
      return true;
    }

    if (session && (yield* idleCompaction.hasActive(session.opencode.sessionId))) {
      yield* context.complete(
        "OpenCode is compacting this channel right now. Wait for compaction to finish or use /interrupt before starting a fresh session.",
      );
      return true;
    }

    if (session && (yield* sessionControl.hasQueuedWork(session))) {
      yield* context.complete(
        "OpenCode still has queued work for this channel. Wait for it to finish before starting a fresh session.",
      );
      return true;
    }

    yield* context.ack();
    yield* sessionControl.invalidate(
      context.channelId,
      "requested a fresh session via /new-session",
    );
    yield* infoCards
      .upsert({
        channel: context.guildTextChannel,
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
    return true;
  }),
});
