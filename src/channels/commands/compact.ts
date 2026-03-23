import { Effect } from "effect";

import { CommandContext } from "@/discord/command-context.ts";
import { decideCompactEntry, GUILD_TEXT_COMMAND_ONLY_MESSAGE } from "@/channels/command-policy.ts";
import type { GuildCommand } from "@/channels/commands.ts";
import { SessionRuntime } from "@/sessions/session-runtime.ts";

export const compactCommand = {
  name: "compact",
  description: "Compact the current OpenCode session in this channel",
  execute: Effect.gen(function* () {
    const context = yield* CommandContext;
    const sessionRuntime = yield* SessionRuntime;

    if (!context.inGuildTextChannel || !context.guildTextChannel) {
      yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
      return;
    }

    const channelActivity = yield* sessionRuntime.activity.readChannel(
      context.channelId,
      "restored",
    );
    const entry = decideCompactEntry({
      channelActivity,
    });
    if (entry.type === "reject") {
      yield* context.complete(entry.message);
      return;
    }

    yield* context.ack();
    const result = yield* sessionRuntime.compaction.start(
      context.channelId,
      context.guildTextChannel!,
    );

    if (result.type === "rejected") {
      yield* context.complete(result.message);
      return;
    }

    yield* context.complete("Started session compaction. I'll post updates in this channel.");
  }),
} satisfies GuildCommand;
