import type { PatchPart } from "@opencode-ai/sdk/v2"
import type { EventPermissionReplied, PermissionRequest, SessionStatus } from "@opencode-ai/sdk/v2"

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

export const formatPermissionAsked = (permission: PermissionRequest) => {
  const tool = permission.tool ? `\`${permission.permission}\` for tool call \`${permission.tool.callID}\`` : `\`${permission.permission}\``
  return ["## 🔐 Permission needed", `- Waiting for approval: ${tool}`].join("\n")
}

export const formatPermissionReplied = (reply: EventPermissionReplied["properties"]) =>
  ["## 🔓 Permission resolved", `- Decision: \`${reply.reply}\``].join("\n")

export const formatThinkingCompleted = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  return `*🧠 ${trimmed}*`
}
