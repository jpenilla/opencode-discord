import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { Effect } from "effect";

export const replyToCommandInteraction = (
  interaction: ChatInputCommandInteraction,
  message: string,
) => {
  if (interaction.replied || interaction.deferred) {
    return Effect.void;
  }
  return Effect.promise(() =>
    interaction.reply({
      content: message,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    }),
  ).pipe(Effect.ignore);
};

export const deferCommandInteraction = (interaction: ChatInputCommandInteraction) => {
  if (interaction.replied || interaction.deferred) {
    return Effect.void;
  }
  return Effect.promise(() => interaction.deferReply({ flags: MessageFlags.Ephemeral })).pipe(
    Effect.ignore,
  );
};

export const editCommandInteraction = (
  interaction: ChatInputCommandInteraction,
  message: string,
) => {
  if (!interaction.replied && !interaction.deferred) {
    return replyToCommandInteraction(interaction, message);
  }
  return Effect.promise(() =>
    interaction.editReply({
      content: message,
      allowedMentions: { parse: [] },
    }),
  ).pipe(Effect.ignore);
};
