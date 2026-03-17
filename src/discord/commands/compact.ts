import { Effect } from "effect";

import { CommandContext } from "@/discord/commands/command-context.ts";
import { IdleCompactionWorkflow } from "@/sessions/idle-compaction-workflow.ts";
import { SessionControl } from "@/sessions/session-control.ts";
import { defineGuildCommand } from "./definition.ts";
import { GUILD_TEXT_COMMAND_ONLY_MESSAGE } from "@/sessions/command-lifecycle.ts";

export const compactCommand = defineGuildCommand({
  name: "compact",
  description: "Compact the current OpenCode session in this channel",
  execute: Effect.gen(function* () {
    const context = yield* CommandContext;
    const sessionControl = yield* SessionControl;
    const idleCompaction = yield* IdleCompactionWorkflow;

    if (!context.inGuildTextChannel || !context.guildTextChannel) {
      yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
      return;
    }

    const session = yield* sessionControl.getOrRestore(context.channelId);
    if (!session) {
      yield* context.complete("No OpenCode session exists in this channel yet.");
      return;
    }
    if (session.activeRun) {
      yield* context.complete(
        "OpenCode is busy in this channel right now. Use /interrupt first or wait for the current run to finish.",
      );
      return;
    }

    yield* context.ack();
    yield* sessionControl.attachProgressChannel(session, context.guildTextChannel);
    const result = yield* idleCompaction.start({
      session,
      channel: context.guildTextChannel,
    });

    if (result.type === "rejected") {
      yield* context.complete(result.message);
      return;
    }

    yield* context.complete("Started session compaction. I'll post updates in this channel.");
  }),
});
