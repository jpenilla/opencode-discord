import { Effect } from "effect";

import { CommandContext } from "@/discord/commands/command-context.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { OpencodeService } from "@/opencode/service.ts";
import { IdleCompactionWorkflow } from "@/sessions/idle-compaction-workflow.ts";
import {
  decideInterruptEntry,
  GUILD_TEXT_COMMAND_ONLY_MESSAGE,
  QUESTION_PENDING_INTERRUPT_MESSAGE,
} from "@/sessions/command-lifecycle.ts";
import { SessionControl } from "@/sessions/session-control.ts";
import { formatError } from "@/util/errors.ts";
import { defineGuildCommand } from "./definition.ts";

export const interruptCommand = defineGuildCommand({
  name: "interrupt",
  description: "Interrupt the active OpenCode run in this channel",
  execute: Effect.gen(function* () {
    const context = yield* CommandContext;
    const sessionControl = yield* SessionControl;
    const idleCompaction = yield* IdleCompactionWorkflow;
    const opencode = yield* OpencodeService;

    if (!context.inGuildTextChannel) {
      yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
      return;
    }

    const channelActivity = yield* sessionControl.readRestoredChannelActivity(context.channelId);
    const entry = decideInterruptEntry({
      channelActivity,
    });
    if (entry.type === "reject") {
      yield* context.complete(entry.message);
      return;
    }
    if (channelActivity.type !== "present") {
      return;
    }

    if (entry.target === "run") {
      yield* context.ack();
      const activeRun = channelActivity.session.activeRun!;
      yield* sessionControl.setRunInterruptRequested(activeRun, true);
      const interruptResult = yield* opencode
        .interruptSession(channelActivity.session.opencode)
        .pipe(Effect.result);
      if (interruptResult._tag === "Failure") {
        yield* sessionControl.setRunInterruptRequested(activeRun, false);
        yield* context.complete(
          formatErrorResponse(
            "## ❌ Failed to interrupt run",
            formatError(interruptResult.failure),
          ),
        );
        return;
      }

      const updatedActivity = yield* sessionControl.readSessionActivity(channelActivity.session);
      if (updatedActivity.hasPendingQuestions) {
        yield* sessionControl.setRunInterruptRequested(activeRun, false);
        yield* context.complete(QUESTION_PENDING_INTERRUPT_MESSAGE);
        return;
      }

      yield* context.complete("Requested interruption of the active OpenCode run.");
      return;
    }

    yield* context.ack();
    const result = yield* idleCompaction.requestInterrupt({ session: channelActivity.session });
    if (result.type === "failed") {
      yield* context.complete(result.message);
      return;
    }

    yield* context.complete("Requested interruption of the active OpenCode compaction.");
  }),
});
