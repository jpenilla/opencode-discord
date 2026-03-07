import { formatCodeBlock } from "@/discord/formatting.ts"

const formatValue = (value: unknown) => {
  if (value === undefined || value === null) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const formatToolState = (value: unknown) => {
  if (value === undefined) {
    return ""
  }
  if (typeof value === "string") {
    return value.trim()
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return formatValue(value)
  }
}

const toolStateLanguage = (value: unknown) => (typeof value === "string" ? "text" : "json")

export const renderToolTranscriptPart = (part: any) => {
  const status = part.state?.status ?? "unknown"
  const title = part.state?.title ? ` - ${part.state.title}` : ""
  const sections = [`## ${status === "completed" ? "✅" : status === "error" ? "❌" : "🔧"} Tool: \`${part.tool}\``, `- Status: \`${status}\`${title}`]
  const input = formatToolState(part.state?.input)
  if (input) {
    sections.push("", "### Input", formatCodeBlock(input, toolStateLanguage(part.state?.input)))
  }
  const output = formatToolState(part.state?.output)
  if (output) {
    sections.push("", "### Output", formatCodeBlock(output))
  }
  const error = formatToolState(part.state?.error)
  if (error) {
    sections.push("", "### Error", formatCodeBlock(error))
  }
  return sections.filter(Boolean).join("\n")
}
