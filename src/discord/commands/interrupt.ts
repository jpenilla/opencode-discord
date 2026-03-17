import { Effect } from "effect";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import {
  QUESTION_PENDING_INTERRUPT_MESSAGE,
  decideInterruptEntry,
} from "@/sessions/command-lifecycle.ts";

import { defineSessionCommand, type GuildCommand } from "./definition.ts";
import {
  deferCommandInteraction,
  editCommandInteraction,
  replyToCommandInteraction,
} from "./interaction.ts";

const executeInterruptSession: GuildCommand["execute"] = (context) =>
  Effect.gen(function* () {
    const hasPendingQuestions = context.session?.activeRun
      ? yield* context.deps.hasPendingQuestions(context.session.opencode.sessionId)
      : false;
    const interruptEntry = decideInterruptEntry({
      inGuildTextChannel: context.inGuildTextChannel,
      hasSession: !!context.session,
      hasActiveRun: !!context.session?.activeRun,
      hasPendingQuestions,
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
      const interruptingCard = compactionCardContent("interrupting");
      yield* context.deps.updateIdleCompactionCard(
        session.opencode.sessionId,
        interruptingCard.title,
        interruptingCard.body,
      );
      const interruptResult = yield* context.deps
        .interruptSession(session.opencode)
        .pipe(Effect.result);
      if (interruptResult._tag === "Failure") {
        yield* context.deps.setIdleCompactionInterruptRequested(session.opencode.sessionId, false);
        const compactingCard = compactionCardContent("compacting");
        yield* context.deps.updateIdleCompactionCard(
          session.opencode.sessionId,
          compactingCard.title,
          compactingCard.body,
        );
        yield* editCommandInteraction(
          context.interaction,
          formatErrorResponse(
            "## ❌ Failed to interrupt compaction",
            context.deps.formatError(interruptResult.failure),
          ),
        );
        return true;
      }

      yield* editCommandInteraction(
        context.interaction,
        "Requested interruption of the active OpenCode compaction.",
      );
      return true;
    }

    const activeRun = session.activeRun!;
    activeRun.interruptRequested = true;
    const interruptResult = yield* context.deps
      .interruptSession(session.opencode)
      .pipe(Effect.result);
    if (interruptResult._tag === "Failure") {
      activeRun.interruptRequested = false;
      yield* editCommandInteraction(
        context.interaction,
        formatErrorResponse(
          "## ❌ Failed to interrupt run",
          context.deps.formatError(interruptResult.failure),
        ),
      );
      return true;
    }

    const hasPendingQuestionsAfterInterrupt = yield* context.deps.hasPendingQuestions(
      session.opencode.sessionId,
    );
    if (hasPendingQuestionsAfterInterrupt) {
      activeRun.interruptRequested = false;
      yield* editCommandInteraction(context.interaction, QUESTION_PENDING_INTERRUPT_MESSAGE);
      return true;
    }

    yield* editCommandInteraction(
      context.interaction,
      "Requested interruption of the active OpenCode run.",
    );
    return true;
  });

export const interruptCommand = defineSessionCommand({
  name: "interrupt",
  description: "Interrupt the active OpenCode run in this channel",
  execute: executeInterruptSession,
});
