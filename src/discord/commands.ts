import { SlashCommandBuilder, type Guild } from "discord.js"

const GUILD_COMMANDS = [
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Compact the current OpenCode session in this channel"),
  new SlashCommandBuilder()
    .setName("interrupt")
    .setDescription("Interrupt the active OpenCode run in this channel"),
].map((command) => command.toJSON())

export const syncGuildCommands = async (guild: Guild) => {
  await guild.commands.set(GUILD_COMMANDS)
}
