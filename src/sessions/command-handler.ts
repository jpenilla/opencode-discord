import { type Interaction } from "discord.js";
import { Effect, Layer } from "effect";

import { getGuildCommand } from "@/discord/commands.ts";
import { CommandContext, makeCommandContextLayer } from "@/discord/commands/command-context.ts";
import type { GuildCommandDependencies } from "@/discord/commands/definition.ts";

export type CommandHandler = {
  handleInteraction: (interaction: Interaction) => Effect.Effect<boolean, unknown>;
};

type CommandHandlerDeps = {
  commandLayer: Layer.Layer<GuildCommandDependencies>;
};

const UNHANDLED_COMMAND_ERROR_MESSAGE =
  "An unexpected error occurred while processing this command.";

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

      const commandContextLayer = makeCommandContextLayer(interaction);
      const commandEffect: Effect.Effect<boolean, unknown> = command.execute.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const commandContext = yield* CommandContext;
            yield* commandContext.completeIfAcked(UNHANDLED_COMMAND_ERROR_MESSAGE);
            return yield* Effect.failCause(cause);
          }),
        ),
        Effect.provide(Layer.merge(commandContextLayer, deps.commandLayer)),
      );
      return yield* commandEffect;
    }),
});
