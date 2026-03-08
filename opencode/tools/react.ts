import { tool } from "@opencode-ai/plugin"
import { sendBridgeRequest } from "./bridge.ts"

export default tool({
  description: "Add an emoji reaction to the Discord message that triggered the current run.",
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
