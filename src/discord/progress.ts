import type { PatchPart } from "@opencode-ai/sdk/v2"
import type { SessionStatus } from "@opencode-ai/sdk/v2"

export const formatPatchUpdated = (part: PatchPart) =>
  part.files.length === 0 ? "## 🧩 Patch updated" : `## 🧩 Patch updated\n- Files touched: ${part.files.length}`

export const formatSessionStatus = (status: SessionStatus) => {
  switch (status.type) {
    case "busy":
      return null
    case "idle":
      return null
    case "retry":
      return `*↻ retry ${status.attempt}: ${status.message}*`
  }
}

export const formatThinkingCompleted = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  return `*🧠 ${trimmed}*`
}

export const formatCompactionSummary = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  return `*🗜️ ${trimmed}*`
}
