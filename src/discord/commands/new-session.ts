import type { SendableChannels } from "discord.js";
import { Effect, Queue } from "effect";

import { decideNewSessionEntry } from "@/sessions/command-lifecycle.ts";

import { defineLoadedSessionCommand, type GuildCommand } from "./definition.ts";
import {
  deferCommandInteraction,
  editCommandInteraction,
  replyToCommandInteraction,
} from "./interaction.ts";

const executeNewSession: GuildCommand["execute"] = (context) =>
  Effect.gen(function* () {
    const newSessionEntry = decideNewSessionEntry({
      inGuildTextChannel: context.inGuildTextChannel,
      hasActiveRun: !!context.session?.activeRun,
      hasIdleCompaction:
        context.session && !context.session.activeRun
          ? yield* context.deps.hasIdleCompaction(context.session.opencode.sessionId)
          : false,
      hasQueuedWork:
        context.session && !context.session.activeRun
          ? (yield* Queue.size(context.session.queue)) > 0
          : false,
    });
    if (newSessionEntry.type === "reject") {
      yield* replyToCommandInteraction(context.interaction, newSessionEntry.message);
      return true;
    }

    yield* deferCommandInteraction(context.interaction);
    yield* context.deps.invalidateSession(
      context.interaction.channelId,
      "requested a fresh session via /new-session",
    );
    const channel = context.interaction.channel as SendableChannels;
    yield* Effect.promise(() =>
      context.deps.upsertInfoCard({
        channel,
        existingCard: null,
        title: "🆕 Fresh session ready",
        body: "The next triggered message in this channel will start a new OpenCode session with fresh chat history. Workspace files were left in place.",
      }),
    ).pipe(
      Effect.catch((error) =>
        context.deps.logger.warn("failed to post new-session info card", {
          channelId: context.interaction.channelId,
          error: context.deps.formatError(error),
        }),
      ),
      Effect.asVoid,
    );
    yield* editCommandInteraction(
      context.interaction,
      "Cleared this channel's current OpenCode session. The next triggered message here will start a new session with fresh chat history. Workspace files were left in place.",
    );
    return true;
  });

export const newSessionCommand = defineLoadedSessionCommand({
  name: "new-session",
  description: "Start a fresh OpenCode session in this channel on the next message",
  execute: executeNewSession,
});
