import type { SendableChannels } from "discord.js";
import { Effect } from "effect";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import { decideCompactAfterHealthCheck, decideCompactEntry } from "@/sessions/command-lifecycle.ts";

import { defineSessionCommand, type GuildCommand } from "./definition.ts";
import {
  deferCommandInteraction,
  editCommandInteraction,
  replyToCommandInteraction,
} from "./interaction.ts";

const executeCompactSession: GuildCommand["execute"] = (context) =>
  Effect.gen(function* () {
    const compactEntry = decideCompactEntry({
      inGuildTextChannel: context.inGuildTextChannel,
      hasSession: !!context.session,
      hasActiveRun: !!context.session?.activeRun,
    });
    if (compactEntry.type === "reject") {
      yield* replyToCommandInteraction(context.interaction, compactEntry.message);
      return true;
    }

    yield* deferCommandInteraction(context.interaction);

    const session = context.session!;
    const compactHealthDecision = decideCompactAfterHealthCheck(
      yield* context.deps.isSessionHealthy(session.opencode),
    );
    if (compactHealthDecision.type === "reject-after-defer") {
      yield* editCommandInteraction(context.interaction, compactHealthDecision.message);
      return true;
    }

    const channel = context.interaction.channel as SendableChannels;
    yield* context.deps.beginIdleCompaction(session.opencode.sessionId);
    const existingCard = yield* context.deps.getIdleCompactionCard(session.opencode.sessionId);
    const compactingCard = compactionCardContent("compacting");
    const compactedCard = compactionCardContent("compacted");
    const compactionCard = yield* Effect.promise(() =>
      context.deps.upsertInfoCard({
        channel,
        existingCard,
        title: compactingCard.title,
        body: compactingCard.body,
      }),
    ).pipe(
      Effect.tap((card) => context.deps.setIdleCompactionCard(session.opencode.sessionId, card)),
      Effect.catch((error) =>
        context.deps.logger
          .warn("failed to post idle compaction card", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: context.deps.formatError(error),
          })
          .pipe(Effect.as(null)),
      ),
    );

    yield* context.deps.compactSession(session.opencode).pipe(
      Effect.tap(() =>
        context.deps.finalizeIdleCompactionCard(
          session.opencode.sessionId,
          compactedCard.title,
          compactedCard.body,
        ),
      ),
      Effect.tapError((error) =>
        context.deps.logger.error("failed to compact session", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          error: context.deps.formatError(error),
        }),
      ),
      Effect.catch((error) =>
        compactionCard
          ? context.deps.getIdleCompactionInterruptRequested(session.opencode.sessionId).pipe(
              Effect.flatMap((interruptRequested) =>
                interruptRequested
                  ? (() => {
                      const interruptedCard = compactionCardContent("interrupted");
                      return context.deps.finalizeIdleCompactionCard(
                        session.opencode.sessionId,
                        interruptedCard.title,
                        interruptedCard.body,
                      );
                    })()
                  : context.deps.finalizeIdleCompactionCard(
                      session.opencode.sessionId,
                      "❌ Session compaction failed",
                      `OpenCode could not compact this session.\n\n${context.deps.formatError(
                        error,
                      )}`,
                    ),
              ),
            )
          : Effect.void,
      ),
      Effect.forkDetach({ startImmediately: true }),
    );

    yield* editCommandInteraction(
      context.interaction,
      "Started session compaction. I'll post updates in this channel.",
    );
    return true;
  });

export const compactCommand = defineSessionCommand({
  name: "compact",
  description: "Compact the current OpenCode session in this channel",
  execute: executeCompactSession,
});
