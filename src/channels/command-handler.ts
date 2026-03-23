import { type ChatInputCommandInteraction } from "discord.js";
import { Effect, Layer } from "effect";

import { getGuildCommand, type GuildCommandDependencies } from "@/channels/commands/registry.ts";
import { CommandContext, makeCommandContextLayer } from "@/discord/command-context.ts";

export const createCommandHandler = (commandLayer: Layer.Layer<GuildCommandDependencies>) => ({
  handleInteraction: (interaction: ChatInputCommandInteraction) =>
    Effect.gen(function* () {
      const command = getGuildCommand(interaction.commandName);
      if (!command) {
        return;
      }

      yield* command.execute.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const commandContext = yield* CommandContext;
            yield* commandContext.completeIfAcked(
              "An unexpected error occurred while processing this command.",
            );
            return yield* Effect.failCause(cause);
          }),
        ),
        Effect.provide(Layer.merge(makeCommandContextLayer(interaction), commandLayer)),
      );
    }).pipe(Effect.asVoid),
});
