import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Guild,
} from "discord.js";
import { Context, Effect, Layer, Redacted, Runtime } from "effect";

import { AppConfig } from "@/config.ts";
import { syncGuildCommands } from "@/discord/commands.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { detectInvocation } from "@/discord/triggers.ts";
import { ChannelSessions } from "@/sessions/registry.ts";
import { Logger } from "@/util/logging.ts";

export type DiscordBotShape = {
  client: Client;
};

export class DiscordBot extends Context.Tag("DiscordBot")<DiscordBot, DiscordBotShape>() {}

const formatError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export const DiscordBotLive = Layer.scoped(
  DiscordBot,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const logger = yield* Logger;
    const sessions = yield* ChannelSessions;
    const runtime = yield* Effect.runtime<ChannelSessions | Logger>();

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      allowedMentions: {
        parse: ["users", "roles", "everyone"],
        repliedUser: true,
      },
    });

    const syncCommandsForGuild = async (guild: Guild) => {
      try {
        await syncGuildCommands(guild);
        await Effect.runPromise(
          logger.info("synced guild slash commands", {
            guildId: guild.id,
            guildName: guild.name,
          }),
        );
      } catch (error) {
        await Effect.runPromise(
          logger.error("failed to sync guild slash commands", {
            guildId: guild.id,
            guildName: guild.name,
            error: formatError(error),
          }),
        );
      }
    };

    client.once(Events.ClientReady, (ready) => {
      void ready.user.setPresence({
        activities: [{ name: config.triggerPhrase, type: ActivityType.Listening }],
        status: "online",
      });
      void Effect.runPromise(
        logger.info("discord client ready", {
          user: ready.user.tag,
        }),
      );
      for (const guild of ready.guilds.cache.values()) {
        void syncCommandsForGuild(guild);
      }
    });

    client.on(Events.GuildCreate, (guild) => {
      void syncCommandsForGuild(guild);
    });

    client.on(Events.MessageCreate, async (message) => {
      if (!message.inGuild()) {
        return;
      }
      if (message.channel.type !== ChannelType.GuildText) {
        return;
      }

      const invocation = await detectInvocation({
        client,
        message,
        triggerPhrase: config.triggerPhrase,
        ignoreOtherBotTriggers: config.ignoreOtherBotTriggers,
      });

      if (!invocation) {
        return;
      }

      Runtime.runFork(runtime)(
        sessions.submit(message, invocation).pipe(
          Effect.catchAll((error) => {
            const formattedError = formatError(error);
            return logger
              .error("failed to enqueue message", {
                channelId: message.channelId,
                error: formattedError,
              })
              .pipe(
                Effect.zipRight(
                  Effect.promise(() =>
                    message.reply({
                      content: formatErrorResponse(
                        "## ❌ Failed to start Opencode",
                        formattedError,
                      ),
                      allowedMentions: { repliedUser: false, parse: [] },
                    }),
                  ).pipe(Effect.ignore),
                ),
              );
          }),
        ),
      );
    });

    client.on(Events.InteractionCreate, (interaction) => {
      Runtime.runFork(runtime)(
        sessions.handleInteraction(interaction).pipe(
          Effect.catchAll((error) => {
            const formattedError = formatError(error);
            return logger
              .error("failed to handle interaction", {
                interactionId: interaction.id,
                error: formattedError,
              })
              .pipe(
                Effect.zipRight(
                  interaction.isRepliable() && !interaction.replied && !interaction.deferred
                    ? Effect.promise(() =>
                        interaction.reply({
                          content: formatErrorResponse(
                            "## ❌ Failed to process interaction",
                            formattedError,
                          ),
                          flags: MessageFlags.Ephemeral,
                          allowedMentions: { parse: [] },
                        }),
                      ).pipe(Effect.ignore)
                    : Effect.void,
                ),
              );
          }),
        ),
      );
    });

    yield* Effect.promise(() => client.login(Redacted.value(config.discordToken)));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        client.removeAllListeners();
        yield* sessions.shutdown().pipe(
          Effect.catchAll((error) =>
            logger.warn("failed to shut down channel sessions before discord destroy", {
              error: formatError(error),
            }),
          ),
        );
        yield* Effect.promise(() => client.destroy());
      }),
    );

    return { client } satisfies DiscordBotShape;
  }),
);
