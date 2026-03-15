import type { MessageCreateOptions, SendableChannels } from "discord.js";
import { Effect } from "effect";

import type { ActiveRun } from "@/sessions/session.ts";
import { ToolBridgeResponseError } from "@/tools/bridge/errors.ts";

export const defaultAllowedMentions = {
  parse: ["users", "roles", "everyone"] as const,
};

export const requireSendableChannel = (activeRun: ActiveRun) => {
  const channel = activeRun.discordMessage.channel;
  if (!channel.isSendable()) {
    return Effect.fail(new ToolBridgeResponseError(409, "channel not sendable"));
  }

  return Effect.succeed(channel);
};

export const sendBridgeMessage = (channel: SendableChannels, body: MessageCreateOptions) => {
  return Effect.tryPromise(() =>
    Promise.resolve(
      channel.send({
        ...body,
        allowedMentions: defaultAllowedMentions,
      }),
    ).then(() => undefined),
  );
};
