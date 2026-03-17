import { Effect } from "effect";

import { CommandContext } from "@/discord/commands/command-context.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { OpencodeService } from "@/opencode/service.ts";
import { IdleCompactionWorkflow } from "@/sessions/idle-compaction-workflow.ts";
import {
  GUILD_TEXT_COMMAND_ONLY_MESSAGE,
  QUESTION_PENDING_INTERRUPT_MESSAGE,
} from "@/sessions/command-lifecycle.ts";
import { QuestionStatus } from "@/sessions/question-status.ts";
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
    const questionStatus = yield* QuestionStatus;
    const opencode = yield* OpencodeService;

    if (!context.inGuildTextChannel) {
      yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
      return;
    }

    const session = yield* sessionControl.getOrRestore(context.channelId);
    if (!session) {
      yield* context.complete("No OpenCode session exists in this channel yet.");
      return;
    }

    if (session.activeRun) {
      const hasPendingQuestions = yield* questionStatus.hasPendingQuestions(
        session.opencode.sessionId,
      );
      if (hasPendingQuestions) {
        yield* context.complete(QUESTION_PENDING_INTERRUPT_MESSAGE);
        return;
      }

      yield* context.ack();
      const activeRun = session.activeRun;
      yield* sessionControl.setRunInterruptRequested(activeRun, true);
      const interruptResult = yield* opencode
        .interruptSession(session.opencode)
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

      const hasPendingQuestionsAfterInterrupt = yield* questionStatus.hasPendingQuestions(
        session.opencode.sessionId,
      );
      if (hasPendingQuestionsAfterInterrupt) {
        yield* sessionControl.setRunInterruptRequested(activeRun, false);
        yield* context.complete(QUESTION_PENDING_INTERRUPT_MESSAGE);
        return;
      }

      yield* context.complete("Requested interruption of the active OpenCode run.");
      return;
    }

    const hasIdleCompaction = yield* idleCompaction.hasActive(session.opencode.sessionId);
    if (!hasIdleCompaction) {
      yield* context.complete("No active OpenCode run or compaction is running in this channel.");
      return;
    }

    yield* context.ack();
    const result = yield* idleCompaction.requestInterrupt({ session });
    if (result.type === "failed") {
      yield* context.complete(result.message);
      return;
    }

    yield* context.complete("Requested interruption of the active OpenCode compaction.");
  }),
});
