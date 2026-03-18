import { Effect } from "effect";

import { CommandContext, type CommandContextShape } from "@/discord/commands/command-context.ts";
import { InfoCards } from "@/discord/info-cards.ts";
import { IdleCompactionWorkflow } from "@/sessions/idle-compaction-workflow.ts";
import { decideNewSessionEntry, NEW_SESSION_BUSY_MESSAGE } from "@/sessions/command-lifecycle.ts";
import { SessionControl, type SessionControlShape } from "@/sessions/session-control.ts";
import { formatError } from "@/util/errors.ts";
import { Logger } from "@/util/logging.ts";
import type { IdleCompactionWorkflowShape } from "@/sessions/idle-compaction-workflow.ts";
import { defineGuildCommand } from "./definition.ts";

const readNewSessionEntry = (
  context: CommandContextShape,
  sessionControl: SessionControlShape,
  idleCompaction: IdleCompactionWorkflowShape,
) =>
  Effect.gen(function* () {
    if (!context.inGuildTextChannel || !context.guildTextChannel) {
      return decideNewSessionEntry({
        inGuildTextChannel: false,
        hasPendingQuestions: false,
        hasActiveRun: false,
        hasIdleCompaction: false,
        hasQueuedWork: false,
        hasOtherBusyState: false,
      });
    }

    const session = yield* sessionControl.getLoaded(context.channelId);
    if (!session) {
      return decideNewSessionEntry({
        inGuildTextChannel: true,
        hasPendingQuestions: false,
        hasActiveRun: false,
        hasIdleCompaction: false,
        hasQueuedWork: false,
        hasOtherBusyState: false,
      });
    }

    const { hasPendingQuestions, hasIdleCompaction, hasQueuedWork } = yield* Effect.all({
      hasPendingQuestions: sessionControl.hasPendingQuestions(session.opencode.sessionId),
      hasIdleCompaction: idleCompaction.hasActive(session.opencode.sessionId),
      hasQueuedWork: sessionControl.hasQueuedWork(session),
    });
    const hasActiveRun = Boolean(session.activeRun);
    const hasOtherBusyState =
      hasPendingQuestions || hasActiveRun || hasIdleCompaction
        ? false
        : yield* sessionControl.isSessionBusy(session);

    return decideNewSessionEntry({
      inGuildTextChannel: true,
      hasPendingQuestions,
      hasActiveRun,
      hasIdleCompaction,
      hasQueuedWork,
      hasOtherBusyState,
    });
  });

export const newSessionCommand = defineGuildCommand({
  name: "new-session",
  description: "Start a fresh OpenCode session in this channel on the next message",
  execute: Effect.gen(function* () {
    const context = yield* CommandContext;
    const sessionControl = yield* SessionControl;
    const idleCompaction = yield* IdleCompactionWorkflow;
    const infoCards = yield* InfoCards;
    const logger = yield* Logger;

    const entry = yield* readNewSessionEntry(context, sessionControl, idleCompaction);
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
      const refreshedEntry = yield* readNewSessionEntry(context, sessionControl, idleCompaction);
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
