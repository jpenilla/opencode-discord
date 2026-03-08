import { tool } from "@opencode-ai/plugin"
import { sendBridgeRequest } from "./bridge.ts"

export default tool({
  description: "Send an image from the current session workdir to Discord.",
  args: {
    path: tool.schema.string().describe("Path to the image to upload."),
    caption: tool.schema.string().optional().describe("Optional Discord caption."),
  },
  async execute(args, context) {
    return sendBridgeRequest("/tool/send-image", {
      sessionID: context.sessionID,
      path: args.path,
      caption: args.caption,
    })
  },
})
