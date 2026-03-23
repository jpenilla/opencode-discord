import { SlashCommandBuilder, type Guild } from "discord.js";

import { GUILD_COMMANDS, type GuildCommand } from "@/channels/commands/registry.ts";

const buildSlashCommandPayload = (command: Pick<GuildCommand, "name" | "description">) =>
  new SlashCommandBuilder().setName(command.name).setDescription(command.description).toJSON();

const SLASH_COMMAND_PAYLOADS = GUILD_COMMANDS.map(buildSlashCommandPayload);

export const syncGuildCommands = async (guild: Guild) => {
  await guild.commands.set(SLASH_COMMAND_PAYLOADS);
};
