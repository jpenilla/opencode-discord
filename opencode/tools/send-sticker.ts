import { tool } from "@opencode-ai/plugin";
import { sendBridgeRequest } from "./lib/bridge.ts";

export default tool({
  description: "Send a sticker that is available in the current Discord context by sticker ID.",
  args: {
    stickerId: tool.schema.string().describe("Sticker ID to send."),
    caption: tool.schema.string().optional().describe("Optional Discord caption."),
  },
  async execute(args, context) {
    return sendBridgeRequest("/tool/send-sticker", {
      sessionID: context.sessionID,
      stickerID: args.stickerId,
      caption: args.caption,
    });
  },
});
