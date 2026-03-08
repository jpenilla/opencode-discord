import { tool } from "@opencode-ai/plugin"
import { sendBridgeRequest } from "./bridge.ts"

export default tool({
  description: "Download files attached to the Discord message that triggered this run and the message it replies to, if any, into the session workdir.",
  args: {
    directory: tool.schema.string().optional().describe("Optional destination directory inside the current session workdir."),
  },
  async execute(args, context) {
    return sendBridgeRequest("/tool/download-attachments", {
      sessionID: context.sessionID,
      directory: args.directory,
    })
  },
})
