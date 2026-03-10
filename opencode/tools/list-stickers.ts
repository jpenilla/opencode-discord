import { tool } from "@opencode-ai/plugin";
import { sendBridgeRequest } from "./lib/bridge.ts";

export default tool({
  description: "List the stickers the bot can send in the current Discord context.",
  args: {},
  async execute(_, context) {
    return sendBridgeRequest("/tool/list-stickers", {
      sessionID: context.sessionID,
    });
  },
});
