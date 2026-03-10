import { tool } from "@opencode-ai/plugin";
import { sendBridgeRequest } from "./lib/bridge.ts";

export default tool({
  description: "Send a file from the current session workdir to Discord.",
  args: {
    path: tool.schema.string().describe("Path to the file to upload."),
    caption: tool.schema.string().optional().describe("Optional Discord caption."),
  },
  async execute(args, context) {
    return sendBridgeRequest("/tool/send-file", {
      sessionID: context.sessionID,
      path: args.path,
      caption: args.caption,
    });
  },
});
