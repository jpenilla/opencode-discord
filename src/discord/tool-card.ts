import { ContainerBuilder, TextDisplayBuilder } from "@discordjs/builders"
import { MessageFlags, type Message, type SendableChannels } from "discord.js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { resolve } from "node:path"

const EDIT_TOOL_CARDS = true

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

const toolEmoji = (tool: string) => {
  switch (tool) {
    case "invalid":
      return "⚠️"
    case "question":
      return "❓"
    case "bash":
      return "💻"
    case "read":
      return "📖"
    case "glob":
    case "grep":
      return "🔎"
    case "edit":
    case "write":
      return "✏️"
    case "task":
      return "🧩"
    case "webfetch":
    case "websearch":
      return "🌐"
    case "codesearch":
      return "🧠"
    case "skill":
      return "🎯"
    case "apply_patch":
      return "🩹"
    case "todoread":
    case "todowrite":
      return "📝"
    case "plan_exit":
      return "🚪"
    case "batch":
      return "📦"
    case "lsp":
      return "🧭"
    default:
      return tool.includes("patch") ? "🩹" : "🛠️"
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

const findUnknownInput = (input: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    if (key in input && input[key] !== undefined && input[key] !== null) {
      return input[key]
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
  return trimmed.startsWith("./") ? trimmed.slice(2) : trimmed
}

const relativeToWorkdir = (path: string, workdir: string) => {
  const normalized = normalizePathToken(path)
  for (const alias of workdirAliases(workdir)) {
    const candidates = [alias]
    if (alias.startsWith("/")) {
      candidates.push(alias.slice(1))
    }

    for (const candidate of candidates) {
      if (normalized === candidate) {
        return "."
      }
      if (normalized.startsWith(`${candidate}/`)) {
        return `./${normalized.slice(candidate.length + 1)}`
      }
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

const formatTextValue = (value: string, workdir: string, maxLength: number) => quoted(normalizeDisplayText(value, workdir), maxLength)

const titleCaseKey = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").replace(/^./, (value) => value.toUpperCase())

const isPathLikeKey = (key: string) => /(path|file|dir|cwd|root|target|workspace)/i.test(key)

const compactUrl = (value: string) => {
  try {
    const url = new URL(value)
    const path = url.pathname === "/" ? "" : url.pathname
    const queryEntries = [...url.searchParams.entries()]
    const query =
      queryEntries.length === 0
        ? ""
        : `?${queryEntries
            .slice(0, 2)
            .map(([key, item]) => `${key}=${truncate(item, 24)}`)
            .join("&")}${queryEntries.length > 2 ? "&…" : ""}`
    return `${url.hostname}${path}${query}`
  } catch {
    return null
  }
}

const parseWebfetchTitle = (title: string) => {
  const suffixStart = title.lastIndexOf(" (")
  if (suffixStart === -1 || !title.endsWith(")")) {
    return null
  }

  return {
    url: title.slice(0, suffixStart),
    contentType: title.slice(suffixStart + 2, -1),
  }
}

const summarizeContentType = (value: string) => {
  const mime = value.split(";")[0]?.trim().toLowerCase()
  switch (mime) {
    case "application/json":
      return "JSON"
    case "text/html":
      return "HTML"
    case "text/plain":
      return "Text"
    case "text/markdown":
    case "text/x-markdown":
      return "Markdown"
    default:
      return mime || value
  }
}

const formatGenericValue = (key: string, value: unknown, workdir: string): string | null => {
  if (typeof value === "string") {
    const url = compactUrl(value)
    if (url) {
      return `\`${truncate(url, 140)}\``
    }

    if (isPathLikeKey(key)) {
      return `\`${displayPath(value, workdir)}\``
    }

    return formatTextValue(value, workdir, 160)
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return `\`${String(value)}\``
  }

  if (Array.isArray(value)) {
    return `\`${value.length} items\``
  }

  if (value && typeof value === "object") {
    return `\`${Object.keys(value).length} fields\``
  }

  return null
}

const formatGenericInputLines = (input: Record<string, unknown>, workdir: string) => {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => {
      const formatted = formatGenericValue(key, value, workdir)
      return formatted ? [`- ${titleCaseKey(key)}: ${formatted}`] : []
    })
}

type FormatterInput = {
  part: ToolPart
  workdir: string
  input: Record<string, unknown>
}

type ToolInputFormatter = (input: FormatterInput) => string[]

const formatPatchInputLines: ToolInputFormatter = ({ part, workdir, input }) => {
  const patchInput = findStringInput(input, ["patch", "content", "diff", "input"])
  const patchRaw = "raw" in part.state && typeof part.state.raw === "string" ? part.state.raw : ""
  const patchOutput = part.state.status === "completed" ? part.state.output : ""
  const files = extractPatchFiles(`${patchInput ?? ""}\n${patchRaw}\n${patchOutput}`, workdir)

  if (files.length === 0) {
    return part.state.status === "completed" ? ["- Edited: applied patch"] : []
  }

  if (files.length <= 3) {
    return [`- Edited: ${files.map((file) => `\`${file}\``).join(", ")}`]
  }

  return [`- Edited: ${files.map((file) => `\`${file}\``).join(", ")}`]
}

const formatBashInputLines: ToolInputFormatter = ({ part, workdir, input }) => {
  const command = findStringInput(input, ["cmd", "command", "script", "shell"])
  if (command) {
    return [`- Command: ${formatTextValue(command, workdir, 220)}`]
  }
  if ("raw" in part.state && typeof part.state.raw === "string" && part.state.raw.trim().length > 0) {
    return [`- Command: ${formatTextValue(part.state.raw, workdir, 220)}`]
  }
  return []
}

const formatReadInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const filePath = findStringInput(input, ["filePath", "path", "filepath", "target"])
  if (!filePath) {
    return []
  }
  const normalized = displayPath(filePath, workdir)
  return normalized === "." ? ["- File: `.` (cwd)"] : [`- File: \`${normalized}\``]
}

const formatGlobInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const pattern = findStringInput(input, ["pattern", "glob", "query"])
  const path = findStringInput(input, ["path", "cwd", "root"])
  const hidden = findUnknownInput(input, ["includeHidden", "hidden", "dot"])
  const lines: string[] = []
  if (pattern) lines.push(`- Pattern: ${formatTextValue(pattern, workdir, 180)}`)
  if (path) lines.push(`- Path: \`${displayPath(path, workdir)}\``)
  if (typeof hidden === "boolean") lines.push(`- Hidden: \`${hidden}\``)
  return lines
}

const formatGrepInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const pattern = findStringInput(input, ["pattern", "query", "search"])
  const path = findStringInput(input, ["path", "cwd", "root"])
  const caseSensitive = findUnknownInput(input, ["caseSensitive", "ignoreCase"])
  const context = findUnknownInput(input, ["context", "before", "after"])
  const lines: string[] = []
  if (pattern) lines.push(`- Pattern: ${formatTextValue(pattern, workdir, 180)}`)
  if (path) lines.push(`- Path: \`${displayPath(path, workdir)}\``)
  if (typeof caseSensitive === "boolean") lines.push(`- Case Sensitive: \`${caseSensitive}\``)
  if (typeof context === "number") lines.push(`- Context: \`${context}\``)
  return lines
}

const formatEditInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const path = findStringInput(input, ["filePath", "path", "file"])
  const search = findStringInput(input, ["oldText", "search", "find"])
  const replace = findStringInput(input, ["newText", "replace", "replacement"])
  const lines: string[] = []
  if (path) lines.push(`- File: \`${displayPath(path, workdir)}\``)
  if (search && replace) {
    lines.push(`- Edit: ${formatTextValue(`${singleLine(search)} -> ${singleLine(replace)}`, workdir, 200)}`)
  }
  return lines
}

const formatWriteInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const path = findStringInput(input, ["filePath", "path", "file"])
  const content = findStringInput(input, ["content", "text"])
  const lines: string[] = []
  if (path) lines.push(`- File: \`${displayPath(path, workdir)}\``)
  if (content) lines.push(`- Size: \`${content.length} chars\``)
  return lines
}

const formatTaskInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const description = findStringInput(input, ["description", "prompt", "task"])
  const agent = findStringInput(input, ["agent", "agentID"])
  const model = findStringInput(input, ["model", "modelID"])
  const lines: string[] = []
  if (description) lines.push(`- Task: ${formatTextValue(description, workdir, 200)}`)
  if (agent) lines.push(`- Agent: \`${agent}\``)
  if (model) lines.push(`- Model: \`${model}\``)
  return lines
}

const formatWebfetchInputLines: ToolInputFormatter = ({ part, input }) => {
  const url = findStringInput(input, ["url", "link"])
  const format = findStringInput(input, ["format"])
  const lines: string[] = []

  if (url) {
    const compact = compactUrl(url)
    lines.push(`- URL: \`${compact ? truncate(compact, 180) : truncate(url, 180)}\``)
  }

  if (format && format !== "markdown") {
    lines.push(`- Format: \`${format}\``)
  }

  if (part.state.status === "completed") {
    const title = titleForPart(part)
    if (title) {
      const parsed = parseWebfetchTitle(title)
      if (parsed) {
        if (url && parsed.url !== url) {
          const finalUrl = compactUrl(parsed.url)
          lines.push(`- Final URL: \`${finalUrl ? truncate(finalUrl, 180) : truncate(parsed.url, 180)}\``)
        }
        lines.push(`- Response: \`${summarizeContentType(parsed.contentType)}\``)
      }
    }
  }

  return lines
}

const formatSearchInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const query = findStringInput(input, ["query", "q", "pattern", "search"])
  const path = findStringInput(input, ["path", "cwd", "root"])
  const lines: string[] = []
  if (query) lines.push(`- Query: ${formatTextValue(query, workdir, 180)}`)
  if (path) lines.push(`- Path: \`${displayPath(path, workdir)}\``)
  return lines
}

const formatSkillInputLines: ToolInputFormatter = ({ input }) => {
  const name = findStringInput(input, ["name", "skill", "id"])
  const action = findStringInput(input, ["action", "mode", "op"])
  const lines: string[] = []
  if (name) lines.push(`- Skill: \`${name}\``)
  if (action) lines.push(`- Action: \`${action}\``)
  return lines
}

const formatTodoInputLines: ToolInputFormatter = ({ input }) => {
  const todos = findUnknownInput(input, ["todos", "items", "tasks"])
  if (!Array.isArray(todos)) {
    return []
  }

  const lines: string[] = []
  for (const todo of todos) {
    if (!todo || typeof todo !== "object") {
      continue
    }

    const record = todo as Record<string, unknown>
    const content =
      (typeof record.content === "string" && record.content) ||
      (typeof record.text === "string" && record.text) ||
      (typeof record.title === "string" && record.title) ||
      "(untitled)"
    const status =
      (typeof record.status === "string" && record.status) ||
      (typeof record.state === "string" && record.state) ||
      (typeof record.done === "boolean" ? (record.done ? "done" : "pending") : "")
    const normalizedStatus = status.toLowerCase()
    const emoji =
      normalizedStatus === "done" || normalizedStatus === "completed"
        ? "✅"
        : normalizedStatus === "in_progress" || normalizedStatus === "in progress"
          ? "⏳"
          : normalizedStatus === "cancelled" || normalizedStatus === "canceled"
            ? "⛔"
            : "🕒"

    lines.push(`${emoji} ${truncate(singleLine(content), 120)}`)
  }
  return lines
}

const formatQuestionInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const question = findStringInput(input, ["question", "prompt", "header"])
  return question ? [`- Question: ${formatTextValue(question, workdir, 180)}`] : []
}

const formatPlanExitInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const reason = findStringInput(input, ["reason", "message", "status"])
  return reason ? [`- Exit: ${formatTextValue(reason, workdir, 180)}`] : []
}

const formatBatchInputLines: ToolInputFormatter = ({ input }) => {
  const items = findUnknownInput(input, ["items", "calls", "tasks"])
  return Array.isArray(items) ? [`- Batched Calls: \`${items.length}\``] : []
}

const formatLspInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const action = findStringInput(input, ["action", "method", "operation"])
  const path = findStringInput(input, ["path", "filePath", "uri"])
  const lines: string[] = []
  if (action) lines.push(`- Action: \`${action}\``)
  if (path) lines.push(`- Path: \`${displayPath(path, workdir)}\``)
  return lines
}

const formatInvalidInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const reason = findStringInput(input, ["reason", "error", "message"])
  return reason ? [`- Reason: ${formatTextValue(reason, workdir, 180)}`] : []
}

const TOOL_INPUT_FORMATTERS: Record<string, ToolInputFormatter> = {
  bash: formatBashInputLines,
  read: formatReadInputLines,
  glob: formatGlobInputLines,
  grep: formatGrepInputLines,
  edit: formatEditInputLines,
  write: formatWriteInputLines,
  task: formatTaskInputLines,
  webfetch: formatWebfetchInputLines,
  websearch: formatSearchInputLines,
  codesearch: formatSearchInputLines,
  skill: formatSkillInputLines,
  todoread: formatTodoInputLines,
  todowrite: formatTodoInputLines,
  question: formatQuestionInputLines,
  plan_exit: formatPlanExitInputLines,
  batch: formatBatchInputLines,
  lsp: formatLspInputLines,
  invalid: formatInvalidInputLines,
}

const formatToolInputLines = (part: ToolPart, workdir: string) => {
  const input = inputObject(part)
  if (part.tool === "apply_patch" || part.tool.includes("patch")) {
    return formatPatchInputLines({ part, workdir, input })
  }

  const formatter = TOOL_INPUT_FORMATTERS[part.tool]
  if (formatter) {
    return formatter({ part, workdir, input })
  }

  return formatGenericInputLines(input, workdir)
}

const shouldShowStep = (part: ToolPart, step: string) => {
  if (part.tool.includes("patch") || part.tool === "todowrite" || part.tool === "grep" || part.tool === "webfetch") {
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

const searchResultInfo = (part: ToolPart): { count: number } | { error: string } | null => {
  if (part.state.status !== "completed") {
    return null
  }

  if (part.tool === "glob") {
    const count = part.state.metadata?.count
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      return { count }
    }
    return { error: "unexpected glob metadata (count missing)" }
  }

  if (part.tool === "grep") {
    const matches = part.state.metadata?.matches
    if (typeof matches === "number" && Number.isFinite(matches) && matches >= 0) {
      return { count: matches }
    }
    return { error: "unexpected grep metadata (matches missing)" }
  }

  return null
}

const renderToolCard = (input: {
  part: ToolPart
  workdir: string
}) => {
  const { part } = input
  const duration = formatDuration(part)
  const statusLabel = duration ? `${formatStatus(part)} in ${duration}` : formatStatus(part)
  const header = part.tool === "todowrite" ? "**📝 Todo list**" : `**${toolEmoji(part.tool)} ${statusEmoji(part)} \`${part.tool}\` ${statusLabel}**`
  const lines = [
    header,
  ]

  const inputLines = formatToolInputLines(part, input.workdir)
  if (inputLines.length > 0) {
    lines.push(...inputLines)
  }

  const title = titleForPart(part)
  if (title) {
    const step = normalizeDisplayText(title, input.workdir)
    if (shouldShowStep(part, step)) {
      lines.push(part.tool === "bash" ? `- Purpose: ${step}` : `- Step: ${step}`)
    }
  }

  const resultInfo = searchResultInfo(part)
  if (resultInfo && "count" in resultInfo) {
    lines.push(`- Results: \`${resultInfo.count}\``)
  } else if (resultInfo && "error" in resultInfo) {
    lines.push(`- Results Error: \`${resultInfo.error}\``)
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
  mode?: "edit-or-send" | "always-send"
}) => {
  const mode = input.mode ?? "edit-or-send"
  if (mode === "edit-or-send" && EDIT_TOOL_CARDS && input.existingCard) {
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
