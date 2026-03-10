import { tool } from "@opencode-ai/plugin";
import { sendBridgeRequest } from "./lib/bridge.ts";

export default tool({
  description:
    "Add an emoji reaction to a Discord message associated with the current run. Supports unicode emoji plus custom emoji as <:name:id>, <a:name:id>, name:id, raw id, or :name: when that custom emoji is available in the current context.",
  args: {
    messageId: tool.schema
      .string()
      .describe("Discord message ID from the current run to react to."),
    emoji: tool.schema.string().describe("Emoji reaction to add."),
  },
  async execute(args, context) {
    return sendBridgeRequest("/tool/react", {
      sessionID: context.sessionID,
      messageId: args.messageId,
      emoji: args.emoji,
    });
  },
});
