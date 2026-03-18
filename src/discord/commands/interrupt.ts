import { Effect } from "effect";

import { CommandContext, type CommandContextShape } from "@/discord/commands/command-context.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { OpencodeService } from "@/opencode/service.ts";
import {
  IdleCompactionWorkflow,
  type IdleCompactionWorkflowShape,
} from "@/sessions/idle-compaction-workflow.ts";
import {
  decideInterruptEntry,
  QUESTION_PENDING_INTERRUPT_MESSAGE,
} from "@/sessions/command-lifecycle.ts";
import { SessionControl, type SessionControlShape } from "@/sessions/session-control.ts";
import { formatError } from "@/util/errors.ts";
import { defineGuildCommand } from "./definition.ts";

const readInterruptEntry = (
  context: CommandContextShape,
  sessionControl: SessionControlShape,
  idleCompaction: IdleCompactionWorkflowShape,
) =>
  Effect.gen(function* () {
    if (!context.inGuildTextChannel) {
      return {
        session: null,
        entry: decideInterruptEntry({
          inGuildTextChannel: false,
          hasSession: false,
          hasActiveRun: false,
          hasPendingQuestions: false,
          hasIdleCompaction: false,
        }),
      };
    }

    const session = yield* sessionControl.getOrRestore(context.channelId);
    const { hasPendingQuestions, hasIdleCompaction } = session
      ? yield* Effect.all({
          hasPendingQuestions: sessionControl.hasPendingQuestions(session.opencode.sessionId),
          hasIdleCompaction: idleCompaction.hasActive(session.opencode.sessionId),
        })
      : { hasPendingQuestions: false, hasIdleCompaction: false };

    return {
      session,
      entry: decideInterruptEntry({
        inGuildTextChannel: true,
        hasSession: session !== null,
        hasActiveRun: Boolean(session?.activeRun),
        hasPendingQuestions,
        hasIdleCompaction,
      }),
    };
  });

export const interruptCommand = defineGuildCommand({
  name: "interrupt",
  description: "Interrupt the active OpenCode run in this channel",
  execute: Effect.gen(function* () {
    const context = yield* CommandContext;
    const sessionControl = yield* SessionControl;
    const idleCompaction = yield* IdleCompactionWorkflow;
    const opencode = yield* OpencodeService;

    const { session, entry } = yield* readInterruptEntry(context, sessionControl, idleCompaction);
    if (entry.type === "reject") {
      yield* context.complete(entry.message);
      return;
    }

    if (entry.target === "run") {
      yield* context.ack();
      const activeRun = session!.activeRun!;
      yield* sessionControl.setRunInterruptRequested(activeRun, true);
      const interruptResult = yield* opencode
        .interruptSession(session!.opencode)
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

      const hasPendingQuestionsAfterInterrupt = yield* sessionControl.hasPendingQuestions(
        session!.opencode.sessionId,
      );
      if (hasPendingQuestionsAfterInterrupt) {
        yield* sessionControl.setRunInterruptRequested(activeRun, false);
        yield* context.complete(QUESTION_PENDING_INTERRUPT_MESSAGE);
        return;
      }

      yield* context.complete("Requested interruption of the active OpenCode run.");
      return;
    }

    yield* context.ack();
    const result = yield* idleCompaction.requestInterrupt({ session: session! });
    if (result.type === "failed") {
      yield* context.complete(result.message);
      return;
    }

    yield* context.complete("Requested interruption of the active OpenCode compaction.");
  }),
});
