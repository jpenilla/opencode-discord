import { DiscordAPIError } from "discord.js";
import type { MessageCreateOptions, SendableChannels } from "discord.js";
import { Effect } from "effect";

import type { ActiveRun } from "@/sessions/types.ts";
import {
  ToolBridgeDiscordApiError,
  ToolBridgeResponseError,
  toolBridgeInternalError,
} from "@/tools/bridge/errors.ts";
import { formatError } from "@/util/errors.ts";

export const tryBridgePromise = <A>(message: string, promise: () => Promise<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (cause) =>
      cause instanceof DiscordAPIError
        ? new ToolBridgeDiscordApiError({
            message: cause.message,
            status: cause.status,
            code: cause.code,
            cause,
          })
        : toolBridgeInternalError(
            cause === undefined ? message : formatError(cause) || message,
            cause,
          ),
  });

export const requireSendableChannel = (activeRun: ActiveRun) => {
  const channel = activeRun.originMessage.channel;
  if (!channel.isSendable()) {
    return Effect.fail(
      new ToolBridgeResponseError({ status: 409, message: "channel not sendable" }),
    );
  }

  return Effect.succeed(channel);
};

export const sendBridgeMessage = (channel: SendableChannels, body: MessageCreateOptions) => {
  return tryBridgePromise("sending a Discord message failed", () =>
    Promise.resolve(
      channel.send({
        ...body,
        allowedMentions: {
          parse: ["users", "roles", "everyone"] as const,
        },
      }),
    ).then(() => undefined),
  );
};
