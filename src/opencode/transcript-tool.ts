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

const isDismissedQuestionError = (part: any, error: string) => {
  if (part.tool !== "question" || part.state?.status !== "error") {
    return false
  }

  const normalized = error.toLowerCase()
  return normalized.includes("dismissed this question") || normalized.includes("user dismissed")
}

export const renderToolTranscriptPart = (part: any) => {
  const status = part.state?.status ?? "unknown"
  const title = part.state?.title ? ` - ${part.state.title}` : ""
  const error = formatToolState(part.state?.error)
  if (isDismissedQuestionError(part, error)) {
    return ""
  }

  const sections = [`## ${status === "completed" ? "✅" : status === "error" ? "❌" : "🔧"} Tool: \`${part.tool}\``, `- Status: \`${status}\`${title}`]
  const input = formatToolState(part.state?.input)
  if (input) {
    sections.push("", "### Input", formatCodeBlock(input, toolStateLanguage(part.state?.input)))
  }
  const output = formatToolState(part.state?.output)
  if (output) {
    sections.push("", "### Output", formatCodeBlock(output))
  }
  if (error) {
    sections.push("", "### Error", formatCodeBlock(error))
  }
  return sections.filter(Boolean).join("\n")
}
