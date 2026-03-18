import { Effect } from "effect";

import {
  decideInterruptEntry,
  GUILD_TEXT_COMMAND_ONLY_MESSAGE,
  QUESTION_PENDING_INTERRUPT_MESSAGE,
} from "@/channels/command-policy.ts";
import { CommandContext } from "@/discord/commands/command-context.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { SessionRuntime } from "@/sessions/session-runtime.ts";
import { formatError } from "@/util/errors.ts";
import { defineGuildCommand } from "./definition.ts";

export const interruptCommand = defineGuildCommand({
  name: "interrupt",
  description: "Interrupt the active OpenCode run in this channel",
  execute: Effect.gen(function* () {
    const context = yield* CommandContext;
    const sessionRuntime = yield* SessionRuntime;

    if (!context.inGuildTextChannel) {
      yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
      return;
    }

    const channelActivity = yield* sessionRuntime.readRestoredChannelActivity(context.channelId);
    const entry = decideInterruptEntry({
      channelActivity,
    });
    if (entry.type === "reject") {
      yield* context.complete(entry.message);
      return;
    }

    if (entry.target === "run") {
      yield* context.ack();
      const interruptResult = yield* sessionRuntime.requestRunInterrupt(context.channelId);
      if (interruptResult.type === "failed") {
        yield* context.complete(
          formatErrorResponse("## ❌ Failed to interrupt run", formatError(interruptResult.error)),
        );
        return;
      }
      if (interruptResult.type === "question-pending") {
        yield* context.complete(QUESTION_PENDING_INTERRUPT_MESSAGE);
        return;
      }

      yield* context.complete("Requested interruption of the active OpenCode run.");
      return;
    }

    yield* context.ack();
    const result = yield* sessionRuntime.requestCompactionInterrupt(context.channelId);
    if (result.type === "failed") {
      yield* context.complete(result.message);
      return;
    }

    yield* context.complete("Requested interruption of the active OpenCode compaction.");
  }),
});
