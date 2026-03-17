import {
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type SendableChannels,
} from "discord.js";
import { Effect, Layer, Ref, ServiceMap } from "effect";

type CommandContextState = "fresh" | "acked" | "completed";

export type CommandContextShape = {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  inGuildTextChannel: boolean;
  guildTextChannel: SendableChannels | null;
  ack: () => Effect.Effect<void, unknown>;
  complete: (message: string) => Effect.Effect<void, unknown>;
  completeIfAcked: (message: string) => Effect.Effect<void, unknown>;
};

export class CommandContext extends ServiceMap.Service<CommandContext, CommandContextShape>()(
  "CommandContext",
) {}

const invalidTransition = (transition: string, state: CommandContextState): Effect.Effect<never> =>
  Effect.die(new Error(`invalid command context transition: ${transition} from state ${state}`));

const replyPayload = (message: string): InteractionReplyOptions => ({
  content: message,
  flags: MessageFlags.Ephemeral,
  allowedMentions: { parse: [] },
});

const editPayload = (message: string): InteractionEditReplyOptions => ({
  content: message,
  allowedMentions: { parse: [] },
});

export const makeCommandContextLayer = (
  interaction: ChatInputCommandInteraction,
): Layer.Layer<CommandContext> =>
  Layer.effect(
    CommandContext,
    Effect.gen(function* () {
      const state = yield* Ref.make<CommandContextState>("fresh");
      const inGuildTextChannel =
        interaction.inGuild() && interaction.channel?.type === ChannelType.GuildText;

      return {
        interaction,
        channelId: interaction.channelId,
        inGuildTextChannel,
        guildTextChannel: inGuildTextChannel ? (interaction.channel as SendableChannels) : null,
        ack: () =>
          Ref.modify(state, (current) => {
            if (current !== "fresh") {
              return [invalidTransition("ack", current), current] as const;
            }
            if (interaction.replied || interaction.deferred) {
              return [
                invalidTransition("ack with externally mutated interaction", current),
                current,
              ] as const;
            }

            return [
              Effect.promise(() => interaction.deferReply({ flags: MessageFlags.Ephemeral })).pipe(
                Effect.asVoid,
              ),
              "acked" as const,
            ] as const;
          }).pipe(Effect.flatten),
        complete: (message) =>
          Ref.modify(state, (current) => {
            if (current === "completed") {
              return [invalidTransition("complete", current), current] as const;
            }

            if (current === "fresh") {
              if (interaction.replied || interaction.deferred) {
                return [
                  invalidTransition("complete with externally mutated interaction", current),
                  current,
                ] as const;
              }

              return [
                Effect.promise(() => interaction.reply(replyPayload(message))).pipe(Effect.asVoid),
                "completed" as const,
              ] as const;
            }

            if (!interaction.deferred && !interaction.replied) {
              return [
                invalidTransition("complete without deferred interaction", current),
                current,
              ] as const;
            }

            return [
              Effect.promise(() => interaction.editReply(editPayload(message))).pipe(Effect.asVoid),
              "completed" as const,
            ] as const;
          }).pipe(Effect.flatten),
        completeIfAcked: (message) =>
          Ref.modify(state, (current) => {
            if (current !== "acked") {
              return [Effect.void, current] as const;
            }

            return [
              Effect.promise(() => interaction.editReply(editPayload(message))).pipe(Effect.asVoid),
              "completed" as const,
            ] as const;
          }).pipe(Effect.flatten),
      } satisfies CommandContextShape;
    }),
  );
