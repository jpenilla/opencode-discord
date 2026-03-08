import { ContainerBuilder, TextDisplayBuilder } from "@discordjs/builders"
import { MessageFlags, type Message, type SendableChannels } from "discord.js"
import type { ToolPart } from "@opencode-ai/sdk/v2"

const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength - 1)}…`
}

const formatStatus = (part: ToolPart) => {
  switch (part.state.status) {
    case "pending":
      return "Queued"
    case "running":
      return "Running"
    case "completed":
      return "Completed"
    case "error":
      return "Failed"
  }
}

const statusEmoji = (part: ToolPart) => {
  switch (part.state.status) {
    case "pending":
      return "⏳"
    case "running":
      return "🛠️"
    case "completed":
      return "✅"
    case "error":
      return "❌"
  }
}

const formatDuration = (part: ToolPart) => {
  if (part.state.status !== "completed" && part.state.status !== "error") {
    return null
  }

  const start = part.state.time.start
  const end = part.state.time.end
  const milliseconds = Math.max(0, end - start)
  return `${(milliseconds / 1000).toFixed(2)}s`
}

const titleForPart = (part: ToolPart) =>
  part.state.status === "running" || part.state.status === "completed" ? part.state.title : undefined

const renderToolCard = (input: {
  toolIndex: number
  part: ToolPart
}) => {
  const { part, toolIndex } = input
  const lines = [
    `## ${statusEmoji(part)} Tool ${toolIndex}: \`${part.tool}\``,
    `- Status: **${formatStatus(part)}**`,
    `- Call: \`${part.callID}\``,
  ]

  const title = titleForPart(part)
  if (title) {
    lines.push(`- Step: ${title}`)
  }

  const duration = formatDuration(part)
  if (duration) {
    lines.push(`- Duration: ${duration}`)
  }

  if (part.state.status === "error") {
    lines.push(`- Error: \`${truncate(part.state.error, 600)}\``)
  }

  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join("\n")),
  )

  return [container]
}

const createPayload = (input: {
  toolIndex: number
  part: ToolPart
  includeNotificationSuppression: boolean
}) => ({
  flags: input.includeNotificationSuppression
    ? MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications
    : MessageFlags.IsComponentsV2,
  components: renderToolCard({
    toolIndex: input.toolIndex,
    part: input.part,
  }),
  allowedMentions: { parse: [] as Array<never> },
})

export const upsertToolCard = async (input: {
  sourceMessage: Message
  existingCard: Message | null
  toolIndex: number
  part: ToolPart
}) => {
  if (input.existingCard) {
    try {
      await input.existingCard.edit(
        createPayload({
          toolIndex: input.toolIndex,
          part: input.part,
          includeNotificationSuppression: false,
        }),
      )
      return input.existingCard
    } catch {
      // fall through and create a fresh card if the previous message was deleted/uneditable.
    }
  }

  if (!input.sourceMessage.channel.isSendable()) {
    throw new Error("Channel is not sendable for tool progress card")
  }

  return (input.sourceMessage.channel as SendableChannels).send(
    createPayload({
      toolIndex: input.toolIndex,
      part: input.part,
      includeNotificationSuppression: true,
    }),
  )
}
