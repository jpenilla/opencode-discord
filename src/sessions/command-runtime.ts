import {
  ChannelType,
  MessageFlags,
  type Interaction,
  type Message,
  type SendableChannels,
} from "discord.js";
import { Effect } from "effect";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import {
  GUILD_COMMAND_NAME,
  isGuildCommandName,
  isVisibilityToggleCommandName,
} from "@/discord/commands.ts";
import {
  beginInterruptRequest,
  decideCompactAfterHealthCheck,
  decideCompactEntry,
  decideInterruptEntry,
  GUILD_TEXT_COMMAND_ONLY_MESSAGE,
} from "@/sessions/command-lifecycle.ts";
import type { ChannelSession } from "@/sessions/session.ts";
import {
  resolveChannelSettings,
  type ChannelSettings,
  type PersistedChannelSettings,
} from "@/state/channel-settings.ts";
import type { LoggerShape } from "@/util/logging.ts";

export type CommandRuntime = {
  handleInteraction: (interaction: Interaction) => Effect.Effect<boolean, unknown>;
};

type CommandRuntimeDeps = {
  getSession: (channelId: string) => Effect.Effect<ChannelSession | null, unknown>;
  getLiveSession: (channelId: string) => Effect.Effect<ChannelSession | null, unknown>;
  getChannelSettings: (
    channelId: string,
  ) => Effect.Effect<PersistedChannelSettings | null, unknown>;
  upsertChannelSettings: (settings: PersistedChannelSettings) => Effect.Effect<void, unknown>;
  channelSettingsDefaults: ChannelSettings;
  hasIdleCompaction: (sessionId: string) => Effect.Effect<boolean, unknown>;
  getIdleCompactionCard: (sessionId: string) => Effect.Effect<Message | null, unknown>;
  beginIdleCompaction: (sessionId: string) => Effect.Effect<void, unknown>;
  setIdleCompactionCard: (sessionId: string, card: Message | null) => Effect.Effect<void, unknown>;
  setIdleCompactionInterruptRequested: (
    sessionId: string,
    interruptRequested: boolean,
  ) => Effect.Effect<void, unknown>;
  getIdleCompactionInterruptRequested: (sessionId: string) => Effect.Effect<boolean, unknown>;
  updateIdleCompactionCard: (
    sessionId: string,
    title: string,
    body: string,
  ) => Effect.Effect<void, unknown>;
  finalizeIdleCompactionCard: (
    sessionId: string,
    title: string,
    body: string,
  ) => Effect.Effect<void, unknown>;
  isSessionHealthy: (session: ChannelSession["opencode"]) => Effect.Effect<boolean, unknown>;
  compactSession: (session: ChannelSession["opencode"]) => Effect.Effect<void, unknown>;
  interruptSession: (session: ChannelSession["opencode"]) => Effect.Effect<void, unknown>;
  upsertInfoCard: (input: {
    channel: SendableChannels;
    existingCard: Message | null;
    title: string;
    body: string;
  }) => Promise<Message>;
  editInfoCard: (message: Message, title: string, body: string) => Promise<unknown>;
  sendInfoCard: (channel: SendableChannels, title: string, body: string) => Promise<unknown>;
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

type VisibilityToggleCommandName =
  | typeof GUILD_COMMAND_NAME.toggleThinking
  | typeof GUILD_COMMAND_NAME.toggleCompactionSummaries;

const replyToCommandInteraction = (interaction: Interaction, message: string) => {
  if (!interaction.isChatInputCommand()) {
    return Effect.void;
  }
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

const deferCommandInteraction = (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) {
    return Effect.void;
  }
  if (interaction.replied || interaction.deferred) {
    return Effect.void;
  }
  return Effect.promise(() => interaction.deferReply({ flags: MessageFlags.Ephemeral })).pipe(
    Effect.ignore,
  );
};

const editCommandInteraction = (interaction: Interaction, message: string) => {
  if (!interaction.isChatInputCommand()) {
    return Effect.void;
  }
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

export const createCommandRuntime = (deps: CommandRuntimeDeps): CommandRuntime => ({
  handleInteraction: (interaction) =>
    Effect.gen(function* () {
      if (!interaction.isChatInputCommand()) {
        return false;
      }

      const { commandName } = interaction;
      if (!isGuildCommandName(commandName)) {
        return false;
      }

      const inGuildTextChannel =
        interaction.inGuild() && interaction.channel?.type === ChannelType.GuildText;
      const session = inGuildTextChannel
        ? yield* isVisibilityToggleCommandName(commandName)
            ? deps.getLiveSession(interaction.channelId)
            : deps.getSession(interaction.channelId)
        : null;
      if (session && interaction.channel?.type === ChannelType.GuildText) {
        session.progressChannel = interaction.channel as SendableChannels;
      }

      const handleVisibilityToggle = (
        toggleCommandName: VisibilityToggleCommandName,
      ): Effect.Effect<boolean, unknown> =>
        Effect.gen(function* () {
          if (!inGuildTextChannel) {
            yield* replyToCommandInteraction(interaction, GUILD_TEXT_COMMAND_ONLY_MESSAGE);
            return true;
          }

          const persistedSettings = yield* deps.getChannelSettings(interaction.channelId);
          const currentSettings = resolveChannelSettings(
            deps.channelSettingsDefaults,
            persistedSettings,
          );
          const nextSettings: PersistedChannelSettings =
            toggleCommandName === GUILD_COMMAND_NAME.toggleThinking
              ? {
                  channelId: interaction.channelId,
                  showThinking: !currentSettings.showThinking,
                  showCompactionSummaries: persistedSettings?.showCompactionSummaries,
                }
              : {
                  channelId: interaction.channelId,
                  showThinking: persistedSettings?.showThinking,
                  showCompactionSummaries: !currentSettings.showCompactionSummaries,
                };

          yield* deps.upsertChannelSettings(nextSettings);

          const resolvedSettings = resolveChannelSettings(
            deps.channelSettingsDefaults,
            nextSettings,
          );
          if (session) {
            session.channelSettings = resolvedSettings;
          }

          yield* replyToCommandInteraction(
            interaction,
            toggleCommandName === GUILD_COMMAND_NAME.toggleThinking
              ? `Thinking messages are now ${
                  resolvedSettings.showThinking ? "enabled" : "disabled"
                } in this channel.`
              : `Compaction summaries are now ${
                  resolvedSettings.showCompactionSummaries ? "enabled" : "disabled"
                } in this channel.`,
          );
          return true;
        });

      switch (commandName) {
        case GUILD_COMMAND_NAME.toggleThinking:
        case GUILD_COMMAND_NAME.toggleCompactionSummaries:
          return yield* handleVisibilityToggle(commandName);
        case GUILD_COMMAND_NAME.compact:
          break;
        case GUILD_COMMAND_NAME.interrupt:
          break;
      }

      if (commandName === GUILD_COMMAND_NAME.compact) {
        const compactEntry = decideCompactEntry({
          inGuildTextChannel,
          hasSession: !!session,
          hasActiveRun: !!session?.activeRun,
        });
        if (compactEntry.type === "reject") {
          yield* replyToCommandInteraction(interaction, compactEntry.message);
          return true;
        }

        yield* deferCommandInteraction(interaction);

        const compactHealthDecision = decideCompactAfterHealthCheck(
          yield* deps.isSessionHealthy(session!.opencode),
        );
        if (compactHealthDecision.type === "reject-after-defer") {
          yield* editCommandInteraction(interaction, compactHealthDecision.message);
          return true;
        }

        const channel = interaction.channel as SendableChannels;
        yield* deps.beginIdleCompaction(session!.opencode.sessionId);
        const existingCard = yield* deps.getIdleCompactionCard(session!.opencode.sessionId);
        const compactingCard = compactionCardContent("compacting");
        const compactedCard = compactionCardContent("compacted");
        const compactionCard = yield* Effect.promise(() =>
          deps.upsertInfoCard({
            channel,
            existingCard,
            title: compactingCard.title,
            body: compactingCard.body,
          }),
        ).pipe(
          Effect.tap((card) => deps.setIdleCompactionCard(session!.opencode.sessionId, card)),
          Effect.catchAll((error) =>
            deps.logger
              .warn("failed to post idle compaction card", {
                channelId: session!.channelId,
                sessionId: session!.opencode.sessionId,
                error: deps.formatError(error),
              })
              .pipe(Effect.as(null)),
          ),
        );

        yield* deps.compactSession(session!.opencode).pipe(
          Effect.tap(() =>
            deps.finalizeIdleCompactionCard(
              session!.opencode.sessionId,
              compactedCard.title,
              compactedCard.body,
            ),
          ),
          Effect.tapError((error) =>
            deps.logger.error("failed to compact session", {
              channelId: session!.channelId,
              sessionId: session!.opencode.sessionId,
              error: deps.formatError(error),
            }),
          ),
          Effect.catchAll((error) =>
            compactionCard
              ? deps.getIdleCompactionInterruptRequested(session!.opencode.sessionId).pipe(
                  Effect.flatMap((interruptRequested) =>
                    interruptRequested
                      ? (() => {
                          const interruptedCard = compactionCardContent("interrupted");
                          return deps.finalizeIdleCompactionCard(
                            session!.opencode.sessionId,
                            interruptedCard.title,
                            interruptedCard.body,
                          );
                        })()
                      : deps.finalizeIdleCompactionCard(
                          session!.opencode.sessionId,
                          "❌ Session compaction failed",
                          `OpenCode could not compact this session.\n\n${deps.formatError(error)}`,
                        ),
                  ),
                )
              : Effect.void,
          ),
          Effect.forkDaemon,
        );

        yield* editCommandInteraction(
          interaction,
          "Started session compaction. I'll post updates in this channel.",
        );
        return true;
      }

      const interruptEntry = decideInterruptEntry({
        inGuildTextChannel,
        hasSession: !!session,
        hasActiveRun: !!session?.activeRun,
        hasIdleCompaction:
          session && !session.activeRun
            ? yield* deps.hasIdleCompaction(session.opencode.sessionId)
            : false,
      });
      if (interruptEntry.type === "reject") {
        yield* replyToCommandInteraction(interaction, interruptEntry.message);
        return true;
      }

      yield* deferCommandInteraction(interaction);

      if (interruptEntry.target === "compaction") {
        yield* deps.setIdleCompactionInterruptRequested(session!.opencode.sessionId, true);
        const interruptResult = yield* deps.interruptSession(session!.opencode).pipe(Effect.either);
        if (interruptResult._tag === "Left") {
          yield* deps.setIdleCompactionInterruptRequested(session!.opencode.sessionId, false);
          yield* editCommandInteraction(
            interaction,
            formatErrorResponse(
              "## ❌ Failed to interrupt compaction",
              deps.formatError(interruptResult.left),
            ),
          );
          return true;
        }

        const interruptingCard = compactionCardContent("interrupting");
        yield* deps.updateIdleCompactionCard(
          session!.opencode.sessionId,
          interruptingCard.title,
          interruptingCard.body,
        );
        yield* editCommandInteraction(
          interaction,
          "Requested interruption of the active OpenCode compaction.",
        );
        return true;
      }

      const activeRun = session!.activeRun!;
      const rollbackInterruptRequest = beginInterruptRequest(activeRun);
      const interruptResult = yield* deps.interruptSession(session!.opencode).pipe(Effect.either);
      if (interruptResult._tag === "Left") {
        rollbackInterruptRequest();
        yield* editCommandInteraction(
          interaction,
          formatErrorResponse(
            "## ❌ Failed to interrupt run",
            deps.formatError(interruptResult.left),
          ),
        );
        return true;
      }

      yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore);
      yield* Effect.promise(async () => {
        await deps.sendInfoCard(
          interaction.channel as SendableChannels,
          "‼️ Run interrupted",
          "OpenCode stopped the active run in this channel.",
        );
      }).pipe(
        Effect.catchAll((error) =>
          deps.logger.warn("failed to post interrupt info card", {
            channelId: session!.channelId,
            sessionId: session!.opencode.sessionId,
            error: deps.formatError(error),
          }),
        ),
        Effect.ignore,
      );
      yield* editCommandInteraction(interaction, "Interrupted the active OpenCode run.");
      return true;
    }),
});
