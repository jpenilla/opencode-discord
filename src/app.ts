import { ActivityType, ChannelType, Client, Events, GatewayIntentBits } from "discord.js"
import { Context, Effect, Layer, Runtime } from "effect"

import { AppConfig } from "@/config.ts"
import { formatErrorResponse } from "@/discord/formatting.ts"
import { detectInvocation } from "@/discord/triggers.ts"
import { ChannelSessions } from "@/sessions/registry.ts"
import { Logger } from "@/util/logging.ts"

export type DiscordBotShape = {
  client: Client
}

export class DiscordBot extends Context.Tag("DiscordBot")<DiscordBot, DiscordBotShape>() {}

const formatError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export const DiscordBotLive = Layer.scoped(
  DiscordBot,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const logger = yield* Logger
    const sessions = yield* ChannelSessions
    const runtime = yield* Effect.runtime<ChannelSessions | Logger>()

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
    })

    client.once(Events.ClientReady, (ready) => {
      void ready.user.setPresence({
        activities: [{ name: config.triggerPhrase, type: ActivityType.Listening }],
        status: "online",
      })
      void Effect.runPromise(
        logger.info("discord client ready", {
          user: ready.user.tag,
        }),
      )
    })

    client.on(Events.MessageCreate, async (message) => {
      if (!message.inGuild()) {
        return
      }
      if (message.channel.type !== ChannelType.GuildText) {
        return
      }
      if (message.author.bot) {
        return
      }

      const invocation = await detectInvocation({
        client,
        message,
        triggerPhrase: config.triggerPhrase,
      })

      if (!invocation) {
        return
      }

      Runtime.runFork(runtime)(
        sessions.submit(message, invocation).pipe(
          Effect.catchAll((error) => {
            const formattedError = formatError(error)
            return logger.error("failed to enqueue message", {
              channelId: message.channelId,
              error: formattedError,
            }).pipe(
              Effect.zipRight(
                Effect.promise(() =>
                  message.reply({
                    content: formatErrorResponse("## ❌ Failed to start Opencode", formattedError),
                    allowedMentions: { repliedUser: false, parse: [] },
                  }),
                ).pipe(Effect.ignore),
              ),
            )
          }),
        ),
      )
    })

    yield* Effect.promise(() => client.login(config.discordToken))

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        client.removeAllListeners()
        await client.destroy()
      }),
    )

    return { client } satisfies DiscordBotShape
  }),
)
