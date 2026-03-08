import { ContainerBuilder, TextDisplayBuilder } from "@discordjs/builders"
import { MessageFlags, type Message, type SendableChannels } from "discord.js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { relative, resolve } from "node:path"

const EDIT_TOOL_CARDS = false

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

const singleLine = (value: string) => value.replace(/\s+/g, " ").trim()

const quoted = (value: string, maxLength: number) => `\`${truncate(singleLine(value), maxLength)}\``

const inputObject = (part: ToolPart) => part.state.input

const findStringInput = (input: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }
  return null
}

const workdirAliases = (workdir: string) => {
  const normalized = resolve(workdir)
  const aliases = new Set<string>([normalized])
  if (normalized.startsWith("/private/")) {
    aliases.add(normalized.slice("/private".length))
  } else if (normalized.startsWith("/var/")) {
    aliases.add(`/private${normalized}`)
  }
  return [...aliases]
}

const normalizePathToken = (token: string) => {
  const trimmed = token.trim()
  if (trimmed.startsWith("/")) {
    return trimmed
  }
  if (trimmed.startsWith("var/")) {
    return `/${trimmed}`
  }
  return trimmed
}

const pathCandidates = (path: string, workdir: string) => {
  const candidates = new Set<string>()
  const normalized = normalizePathToken(path)
  candidates.add(resolve(normalized))
  candidates.add(resolve(workdir, normalized))
  return [...candidates]
}

const relativeToWorkdir = (path: string, workdir: string) => {
  const candidates = pathCandidates(path, workdir)
  for (const alias of workdirAliases(workdir)) {
    for (const absolutePath of candidates) {
      if (absolutePath !== alias && !absolutePath.startsWith(`${alias}/`)) {
        continue
      }
      const rel = relative(alias, absolutePath)
      if (!rel || rel === ".") {
        return "."
      }
      return rel.startsWith(".") ? rel : `./${rel}`
    }
  }
  return null
}

const displayPath = (path: string, workdir: string) => {
  const rel = relativeToWorkdir(path, workdir)
  if (!rel) {
    return path
  }
  if (!rel || rel === ".") {
    return "."
  }
  return rel.startsWith(".") ? rel : `./${rel}`
}

const normalizeDisplayText = (value: string, workdir: string) => {
  return value.replace(/(?:\/private)?\/[^\s`"'|)]+/g, (token) => relativeToWorkdir(token, workdir) ?? token)
}

const extractPatchFiles = (value: string, workdir: string) => {
  const hunkFiles = [...value.matchAll(/\*\*\* (?:Add|Delete|Update|Move to): (.+)/g)].map((match) =>
    displayPath(match[1].trim(), workdir),
  )
  const outputFiles = [...value.matchAll(/(?:^|\n)(?:A|M|D|R\d+|C\d+)\s+([^\n]+)/g)].map((match) =>
    displayPath(match[1].trim(), workdir),
  )
  return [...new Set([...hunkFiles, ...outputFiles])].sort()
}

const formatToolInputSummary = (part: ToolPart, workdir: string) => {
  const input = inputObject(part)

  if (part.tool.includes("patch")) {
    const patchInput = findStringInput(input, ["patch", "content", "diff", "input"])
    const patchRaw = "raw" in part.state && typeof part.state.raw === "string" ? part.state.raw : ""
    const patchOutput = part.state.status === "completed" ? part.state.output : ""
    const files = extractPatchFiles(`${patchInput ?? ""}\n${patchRaw}\n${patchOutput}`, workdir)
    if (files.length === 0) {
      return part.state.status === "completed" ? "- Edited: applied patch" : null
    }
    if (files.length <= 3) {
      return `- Edited: ${files.map((file) => `\`${file}\``).join(", ")}`
    }
    return `- Edited: ${files
      .slice(0, 3)
      .map((file) => `\`${file}\``)
      .join(", ")} (+${files.length - 3} more)`
  }

  if (part.tool === "bash") {
    const command = findStringInput(input, ["cmd", "command", "script", "shell"])
    if (command) {
      return `- Command: ${quoted(normalizeDisplayText(command, workdir), 220)}`
    }
    if ("raw" in part.state && typeof part.state.raw === "string" && part.state.raw.trim().length > 0) {
      return `- Command: ${quoted(normalizeDisplayText(part.state.raw, workdir), 220)}`
    }
  }

  if (part.tool === "read") {
    const filePath = findStringInput(input, ["filePath", "path", "filepath", "target"])
    if (!filePath) {
      return null
    }
    const normalized = displayPath(filePath, workdir)
    if (normalized === ".") {
      return "- File: `.` (cwd)"
    }
    return `- File: \`${normalized}\``
  }

  const preview = Object.entries(input)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, 3)
    .map(([key, value]) => `${key}=${normalizeDisplayText(String(value), workdir)}`)
    .join(", ")

  if (preview.length > 0) {
    return `- Input: ${quoted(preview, 220)}`
  }

  return null
}

const shouldShowStep = (part: ToolPart, step: string) => {
  if (part.tool.includes("patch")) {
    return false
  }
  const compact = singleLine(step)
  if (compact.length === 0 || compact.length > 140) {
    return false
  }
  if (compact === "." || compact.startsWith("./")) {
    return false
  }
  if (/^[./\w-]+$/.test(compact)) {
    return false
  }
  return true
}

const renderToolCard = (input: {
  part: ToolPart
  workdir: string
}) => {
  const { part } = input
  const duration = formatDuration(part)
  const statusLabel = duration ? `${formatStatus(part)} in ${duration}` : formatStatus(part)
  const lines = [
    `**${statusEmoji(part)} \`${part.tool}\` ${statusLabel}**`,
  ]

  const inputSummary = formatToolInputSummary(part, input.workdir)
  if (inputSummary) {
    lines.push(inputSummary)
  }

  const title = titleForPart(part)
  if (title) {
    const step = normalizeDisplayText(title, input.workdir)
    if (shouldShowStep(part, step)) {
      lines.push(`- Step: ${step}`)
    }
  }

  if (part.state.status === "error") {
    lines.push(`- Error: \`${truncate(normalizeDisplayText(part.state.error, input.workdir), 600)}\``)
  }

  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join("\n")),
  )

  return [container]
}

const createPayload = (input: {
  part: ToolPart
  workdir: string
  includeNotificationSuppression: boolean
}) => ({
  flags: input.includeNotificationSuppression
    ? MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications
    : MessageFlags.IsComponentsV2,
  components: renderToolCard({
    part: input.part,
    workdir: input.workdir,
  }),
  allowedMentions: { parse: [] as Array<never> },
})

export const upsertToolCard = async (input: {
  sourceMessage: Message
  existingCard: Message | null
  part: ToolPart
  workdir: string
}) => {
  if (EDIT_TOOL_CARDS && input.existingCard) {
    try {
      await input.existingCard.edit(
        createPayload({
          part: input.part,
          workdir: input.workdir,
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
      part: input.part,
      workdir: input.workdir,
      includeNotificationSuppression: true,
    }),
  )
}
