import { ContainerBuilder, TextDisplayBuilder } from "@discordjs/builders"
import { MessageFlags, type Message, type SendableChannels } from "discord.js"

const createInfoCardPayload = (title: string, body: string) => ({
  flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
  components: [
    new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**${title}**\n${body}`),
    ),
  ],
  allowedMentions: { parse: [] as Array<never> },
})

export const sendSessionCompactedCard = async (sourceMessage: Message) => {
  if (!sourceMessage.channel.isSendable()) {
    throw new Error("Channel is not sendable for session compaction card")
  }

  return (sourceMessage.channel as SendableChannels).send(
    createInfoCardPayload(
      "🗜️ Session compacted",
      "OpenCode summarized earlier context and continued the run.",
    ),
  )
}
