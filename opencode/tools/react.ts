import { tool } from "@opencode-ai/plugin"
import { sendBridgeRequest } from "./bridge.ts"

export default tool({
  description:
    "Add an emoji reaction to the Discord message that triggered the current run. Supports unicode emoji plus custom emoji as <:name:id>, <a:name:id>, name:id, raw id, or :name: when that custom emoji is available in the current context.",
  args: {
    emoji: tool.schema.string().describe("Emoji reaction to add."),
  },
  async execute(args, context) {
    return sendBridgeRequest("/tool/react", {
      sessionID: context.sessionID,
      emoji: args.emoji,
    })
  },
})
