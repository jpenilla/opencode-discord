import { type ChatInputCommandInteraction } from "discord.js";
import { Effect, FileSystem, Layer, Path } from "effect";

import { getGuildCommand } from "@/channels/commands.ts";
import type { GuildCommandDependencies } from "@/channels/commands/definition.ts";
import { CommandContext, makeCommandContextLayer } from "@/discord/command-context.ts";
export type CommandHandler = {
  handleInteraction: (
    interaction: ChatInputCommandInteraction,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;
};

type CommandHandlerDeps = {
  commandLayer: Layer.Layer<GuildCommandDependencies>;
};

const UNHANDLED_COMMAND_ERROR_MESSAGE =
  "An unexpected error occurred while processing this command.";

export const createCommandHandler = (deps: CommandHandlerDeps): CommandHandler => ({
  handleInteraction: (interaction) =>
    Effect.gen(function* () {
      const command = getGuildCommand(interaction.commandName);
      if (!command) {
        return;
      }

      const commandContextLayer = makeCommandContextLayer(interaction);
      const commandEffect: Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =
        command.execute.pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const commandContext = yield* CommandContext;
              yield* commandContext.completeIfAcked(UNHANDLED_COMMAND_ERROR_MESSAGE);
              return yield* Effect.failCause(cause);
            }),
          ),
          Effect.provide(Layer.merge(commandContextLayer, deps.commandLayer)),
        );
      yield* commandEffect;
    }).pipe(Effect.asVoid),
});
