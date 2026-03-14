import { tool } from "@opencode-ai/plugin";
import { sendBridgeRequest } from "./lib/bridge.ts";
import { buildBridgeUploadPayload } from "./lib/upload.ts";

export default tool({
  description: "Send an image to Discord.",
  args: {
    path: tool.schema
      .string()
      .describe(
        "Path to the image to upload. Relative paths resolve from the current working directory; absolute paths are allowed.",
      ),
    caption: tool.schema.string().optional().describe("Optional Discord caption."),
  },
  async execute(args, context) {
    return sendBridgeRequest(
      "/tool/send-image",
      await buildBridgeUploadPayload({
        sessionID: context.sessionID,
        path: args.path,
        caption: args.caption,
        cwd: context.directory,
      }),
    );
  },
});
