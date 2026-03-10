import type { SendableChannels } from "discord.js";
import { Effect } from "effect";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { beginInterruptRequest, decideInterruptEntry } from "@/sessions/command-lifecycle.ts";

import { defineSessionCommand, type GuildCommand } from "./definition.ts";
import {
  deferCommandInteraction,
  editCommandInteraction,
  replyToCommandInteraction,
} from "./interaction.ts";

const executeInterruptSession: GuildCommand["execute"] = (context) =>
  Effect.gen(function* () {
    const interruptEntry = decideInterruptEntry({
      inGuildTextChannel: context.inGuildTextChannel,
      hasSession: !!context.session,
      hasActiveRun: !!context.session?.activeRun,
      hasIdleCompaction:
        context.session && !context.session.activeRun
          ? yield* context.deps.hasIdleCompaction(context.session.opencode.sessionId)
          : false,
    });
    if (interruptEntry.type === "reject") {
      yield* replyToCommandInteraction(context.interaction, interruptEntry.message);
      return true;
    }

    yield* deferCommandInteraction(context.interaction);

    const session = context.session!;
    if (interruptEntry.target === "compaction") {
      yield* context.deps.setIdleCompactionInterruptRequested(session.opencode.sessionId, true);
      const interruptResult = yield* context.deps
        .interruptSession(session.opencode)
        .pipe(Effect.either);
      if (interruptResult._tag === "Left") {
        yield* context.deps.setIdleCompactionInterruptRequested(session.opencode.sessionId, false);
        yield* editCommandInteraction(
          context.interaction,
          formatErrorResponse(
            "## ❌ Failed to interrupt compaction",
            context.deps.formatError(interruptResult.left),
          ),
        );
        return true;
      }

      const interruptingCard = compactionCardContent("interrupting");
      yield* context.deps.updateIdleCompactionCard(
        session.opencode.sessionId,
        interruptingCard.title,
        interruptingCard.body,
      );
      yield* editCommandInteraction(
        context.interaction,
        "Requested interruption of the active OpenCode compaction.",
      );
      return true;
    }

    const activeRun = session.activeRun!;
    const rollbackInterruptRequest = beginInterruptRequest(activeRun);
    const interruptResult = yield* context.deps
      .interruptSession(session.opencode)
      .pipe(Effect.either);
    if (interruptResult._tag === "Left") {
      rollbackInterruptRequest();
      yield* editCommandInteraction(
        context.interaction,
        formatErrorResponse(
          "## ❌ Failed to interrupt run",
          context.deps.formatError(interruptResult.left),
        ),
      );
      return true;
    }

    yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore);
    yield* Effect.promise(async () => {
      await context.deps.sendInfoCard(
        context.interaction.channel as SendableChannels,
        "‼️ Run interrupted",
        "OpenCode stopped the active run in this channel.",
      );
    }).pipe(
      Effect.catchAll((error) =>
        context.deps.logger.warn("failed to post interrupt info card", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          error: context.deps.formatError(error),
        }),
      ),
      Effect.ignore,
    );
    yield* editCommandInteraction(context.interaction, "Interrupted the active OpenCode run.");
    return true;
  });

export const interruptCommand = defineSessionCommand({
  name: "interrupt",
  description: "Interrupt the active OpenCode run in this channel",
  execute: executeInterruptSession,
});
