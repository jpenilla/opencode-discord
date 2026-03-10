import { tool } from "@opencode-ai/plugin";
import { sendBridgeRequest } from "./lib/bridge.ts";

export default tool({
  description:
    "Download files attached to Discord messages associated with the current run into the session workdir.",
  args: {
    messageId: tool.schema
      .string()
      .describe("Discord message ID from the current run to fetch attachments from."),
    directory: tool.schema
      .string()
      .optional()
      .describe("Optional destination directory inside the current session workdir."),
  },
  async execute(args, context) {
    return sendBridgeRequest("/tool/download-attachments", {
      sessionID: context.sessionID,
      messageId: args.messageId,
      directory: args.directory,
    });
  },
});
