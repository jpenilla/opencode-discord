import { Effect } from "effect";

import { CommandContext } from "@/discord/commands/command-context.ts";
import { IdleCompactionWorkflow } from "@/sessions/idle-compaction-workflow.ts";
import {
  decideCompactEntry,
  GUILD_TEXT_COMMAND_ONLY_MESSAGE,
} from "@/sessions/command-lifecycle.ts";
import { SessionRuntime } from "@/sessions/session-runtime.ts";
import { defineGuildCommand } from "./definition.ts";

export const compactCommand = defineGuildCommand({
  name: "compact",
  description: "Compact the current OpenCode session in this channel",
  execute: Effect.gen(function* () {
    const context = yield* CommandContext;
    const sessionRuntime = yield* SessionRuntime;
    const idleCompaction = yield* IdleCompactionWorkflow;

    if (!context.inGuildTextChannel || !context.guildTextChannel) {
      yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
      return;
    }

    const channelActivity = yield* sessionRuntime.readRestoredChannelActivity(context.channelId);
    const entry = decideCompactEntry({
      channelActivity,
    });
    if (entry.type === "reject") {
      yield* context.complete(entry.message);
      return;
    }
    if (channelActivity.type !== "present") {
      return;
    }

    yield* context.ack();
    yield* sessionRuntime.attachProgressChannel(channelActivity.session, context.guildTextChannel!);
    const result = yield* idleCompaction.start({
      session: channelActivity.session,
      channel: context.guildTextChannel!,
    });

    if (result.type === "rejected") {
      yield* context.complete(result.message);
      return;
    }

    yield* context.complete("Started session compaction. I'll post updates in this channel.");
  }),
});
