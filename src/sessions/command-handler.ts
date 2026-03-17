import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Interaction,
  type SendableChannels,
} from "discord.js";
import { Effect } from "effect";

import { getGuildCommand, type GuildCommandDeps } from "@/discord/commands.ts";
import type { ChannelSession } from "@/sessions/session.ts";

export type CommandHandler = {
  handleInteraction: (interaction: Interaction) => Effect.Effect<boolean, unknown>;
};

type CommandHandlerDeps = GuildCommandDeps;

const attachProgressChannel = (
  interaction: ChatInputCommandInteraction,
  session: ChannelSession | null,
) => {
  if (session && interaction.channel?.type === ChannelType.GuildText) {
    session.progressChannel = interaction.channel as SendableChannels;
  }
};

export const createCommandHandler = (deps: CommandHandlerDeps): CommandHandler => ({
  handleInteraction: (interaction) =>
    Effect.gen(function* () {
      if (!interaction.isChatInputCommand()) {
        return false;
      }

      const command = getGuildCommand(interaction.commandName);
      if (!command) {
        return false;
      }

      const inGuildTextChannel =
        interaction.inGuild() && interaction.channel?.type === ChannelType.GuildText;
      const session = yield* command.resolveSession(deps, interaction, inGuildTextChannel);

      attachProgressChannel(interaction, session);
      return yield* command.execute({
        deps,
        interaction,
        inGuildTextChannel,
        session,
      });
    }),
});
