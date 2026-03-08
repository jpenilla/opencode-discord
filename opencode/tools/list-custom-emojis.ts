import { tool } from "@opencode-ai/plugin"
import { sendBridgeRequest } from "./bridge.ts"

export default tool({
  description:
    "List the custom emojis the bot can use in the current Discord context. The output includes copyable :name: text syntax and reaction inputs.",
  args: {},
  async execute(_, context) {
    return sendBridgeRequest("/tool/list-custom-emojis", {
      sessionID: context.sessionID,
    })
  },
})
