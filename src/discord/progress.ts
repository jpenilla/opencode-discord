import type { PatchPart, StepFinishPart } from "@opencode-ai/sdk/v2"
import type { EventPermissionReplied, PermissionRequest, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2"

const formatToolTitle = (tool: ToolPart) => {
  switch (tool.state.status) {
    case "running":
    case "completed":
      return tool.state.title
    default:
      return tool.tool
  }
}

export const formatRunStarted = () => "## 🚀 Run started\n- Opencode is working on it"

export const formatAssistantMessageStarted = (count: number) =>
  count === 1
    ? "## 💬 Assistant update\n- The assistant started composing a response"
    : `## 💬 Assistant update\n- The assistant started message ${count}`

export const formatAssistantMessageCompleted = () => "## 🧾 Assistant draft complete\n- A stable assistant message was finalized"

export const formatStepStarted = (count: number) =>
  count === 1 ? "## 🪜 Step started\n- Opencode began step 1" : `## 🪜 Step started\n- Opencode began step ${count}`

export const formatStepFinished = (part: StepFinishPart) =>
  [`## ✅ Step finished`, `- Reason: ${part.reason}`, `- Cost: ${part.cost.toFixed(6)}`].join("\n")

export const formatPatchUpdated = (part: PatchPart) =>
  part.files.length === 0
    ? "## 🧩 Patch updated\n- Opencode recorded a patch"
    : ["## 🧩 Patch updated", `- Files: ${part.files.slice(0, 4).map((file) => `\`${file}\``).join(", ")}`].join("\n")

export const formatTextReady = () => "## ✍️ Response draft updated\n- Assistant text content was updated"

export const formatSessionStatus = (status: SessionStatus) => {
  switch (status.type) {
    case "busy":
      return null
    case "idle":
      return "## ✅ Run idle\n- Opencode reported the session is idle"
    case "retry":
      return [
        "## 🔁 Retrying",
        `- Attempt: ${status.attempt}`,
        `- Reason: ${status.message}`,
      ].join("\n")
  }
}

export const formatToolUpdate = (tool: ToolPart) => {
  switch (tool.state.status) {
    case "pending":
      return [`## 🧰 Tool queued`, `- Tool: \`${tool.tool}\``].join("\n")
    case "running":
      return [`## 🛠️ Tool running`, `- Tool: \`${tool.tool}\``, `- Step: ${formatToolTitle(tool)}`].join("\n")
    case "completed":
      return [`## ✅ Tool finished`, `- Tool: \`${tool.tool}\``, `- Step: ${formatToolTitle(tool)}`].join("\n")
    case "error":
      return ["## ❌ Tool failed", `- Tool: \`${tool.tool}\``, `- Error: ${tool.state.error}`].join("\n")
  }
}

export const formatPermissionAsked = (permission: PermissionRequest) => {
  const tool = permission.tool ? `\`${permission.permission}\` for tool call \`${permission.tool.callID}\`` : `\`${permission.permission}\``
  return ["## 🔐 Permission needed", `- Waiting for approval: ${tool}`].join("\n")
}

export const formatPermissionReplied = (reply: EventPermissionReplied["properties"]) =>
  ["## 🔓 Permission resolved", `- Decision: \`${reply.reply}\``].join("\n")
