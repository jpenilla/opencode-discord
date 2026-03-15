import { tool } from "@opencode-ai/plugin";
import { sendBridgeUpload } from "./lib/bridge.ts";
import { prepareBridgeUpload } from "./lib/upload.ts";

export default tool({
  description: "Send a file to Discord.",
  args: {
    path: tool.schema
      .string()
      .describe(
        "Path to the file to upload. Relative paths resolve from the current working directory; absolute paths are allowed.",
      ),
    caption: tool.schema.string().optional().describe("Optional Discord caption."),
  },
  async execute(args, context) {
    return sendBridgeUpload(
      "/tool/send-file",
      prepareBridgeUpload({
        sessionID: context.sessionID,
        path: args.path,
        caption: args.caption,
        cwd: context.directory,
      }),
    );
  },
});
