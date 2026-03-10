import type { Plugin } from "@opencode-ai/plugin";

const SYSTEM_APPEND_ENV = "OPENCODE_DISCORD_SYSTEM_APPEND";

export const DiscordSystemPlugin: Plugin = async () => ({
  "experimental.chat.system.transform": async (input, output) => {
    if (!input.sessionID) {
      return;
    }

    const appendix = process.env[SYSTEM_APPEND_ENV]?.trim();
    if (!appendix) {
      return;
    }

    output.system.push(appendix);
  },
});
