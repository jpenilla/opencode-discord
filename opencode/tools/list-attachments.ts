import { tool } from "@opencode-ai/plugin";
import { sendBridgeRequest } from "./lib/bridge.ts";

export default tool({
  description: "List attachments available from a Discord message.",
  args: {
    messageId: tool.schema
      .string()
      .describe("Discord message ID from the current run to list attachments from."),
  },
  async execute(args, context) {
    return sendBridgeRequest("/tool/list-attachments", {
      sessionID: context.sessionID,
      messageId: args.messageId,
    });
  },
});
