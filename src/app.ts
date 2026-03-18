import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Guild,
} from "discord.js";
import { Effect, Layer, Redacted } from "effect";

import { AppConfig } from "@/config.ts";
import { syncGuildCommands } from "@/discord/commands.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { detectInvocation } from "@/discord/triggers.ts";
import { SessionOrchestrator } from "@/sessions/session-orchestrator.ts";
import { Logger } from "@/util/logging.ts";

const formatError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export const DiscordBotLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const logger = yield* Logger;
    const sessions = yield* SessionOrchestrator;

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

    const syncCommandsForGuild = (guild: Guild) =>
      Effect.runFork(
        Effect.tryPromise(() => syncGuildCommands(guild)).pipe(
          Effect.andThen(
            logger.info("synced guild slash commands", {
              guildId: guild.id,
              guildName: guild.name,
            }),
          ),
          Effect.catch((error) =>
            logger.error("failed to sync guild slash commands", {
              guildId: guild.id,
              guildName: guild.name,
              error: formatError(error),
            }),
          ),
        ),
      );

    client.once(Events.ClientReady, (ready) => {
      void ready.user.setPresence({
        activities: [{ name: config.triggerPhrase, type: ActivityType.Listening }],
        status: "online",
      });
      Effect.runFork(
        logger.info("discord client ready", {
          user: ready.user.tag,
        }),
      );
      for (const guild of ready.guilds.cache.values()) {
        syncCommandsForGuild(guild);
      }
    });

    client.on(Events.GuildCreate, (guild) => {
      syncCommandsForGuild(guild);
    });

    client.on(Events.MessageCreate, (message) => {
      Effect.runFork(
        Effect.gen(function* () {
          if (!message.inGuild()) {
            return;
          }
          if (message.channel.type !== ChannelType.GuildText) {
            return;
          }

          const invocation = yield* Effect.tryPromise(() =>
            detectInvocation({
              client,
              message,
              triggerPhrase: config.triggerPhrase,
              ignoreOtherBotTriggers: config.ignoreOtherBotTriggers,
            }),
          );

          if (!invocation) {
            return;
          }

          yield* sessions.submit(message, invocation).pipe(
            Effect.catch((error) => {
              const formattedError = formatError(error);
              return logger
                .error("failed to enqueue message", {
                  channelId: message.channelId,
                  error: formattedError,
                })
                .pipe(
                  Effect.andThen(
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
          );
        }),
      );
    });

    client.on(Events.InteractionCreate, (interaction) => {
      Effect.runFork(
        sessions.handleInteraction(interaction).pipe(
          Effect.catch((error) => {
            const formattedError = formatError(error);
            return logger
              .error("failed to handle interaction", {
                interactionId: interaction.id,
                error: formattedError,
              })
              .pipe(
                Effect.andThen(
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
          Effect.catch((error) =>
            logger.warn("failed to shut down channel sessions before discord destroy", {
              error: formatError(error),
            }),
          ),
        );
        yield* Effect.promise(() => client.destroy());
      }),
    );
  }),
);
