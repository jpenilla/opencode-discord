import { Effect } from "effect";

import { CommandContext } from "@/discord/commands/command-context.ts";
import { decideCompactEntry, GUILD_TEXT_COMMAND_ONLY_MESSAGE } from "@/channels/command-policy.ts";
import { SessionChannelBridge } from "@/sessions/session-runtime.ts";
import { defineGuildCommand } from "./definition.ts";

export const compactCommand = defineGuildCommand({
  name: "compact",
  description: "Compact the current OpenCode session in this channel",
  execute: Effect.gen(function* () {
    const context = yield* CommandContext;
    const sessionBridge = yield* SessionChannelBridge;

    if (!context.inGuildTextChannel || !context.guildTextChannel) {
      yield* context.complete(GUILD_TEXT_COMMAND_ONLY_MESSAGE);
      return;
    }

    const channelActivity = yield* sessionBridge.readRestoredChannelActivity(context.channelId);
    const entry = decideCompactEntry({
      channelActivity,
    });
    if (entry.type === "reject") {
      yield* context.complete(entry.message);
      return;
    }

    yield* context.ack();
    const result = yield* sessionBridge.startCompaction(
      context.channelId,
      context.guildTextChannel!,
    );

    if (result.type === "rejected") {
      yield* context.complete(result.message);
      return;
    }

    yield* context.complete("Started session compaction. I'll post updates in this channel.");
  }),
});
