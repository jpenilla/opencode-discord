import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type SendableChannels,
} from "discord.js";
import { Effect } from "effect";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
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

export type GuildCommandRuntimeDeps = {
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

export type GuildCommandExecutionContext = {
  deps: GuildCommandRuntimeDeps;
  interaction: ChatInputCommandInteraction;
  inGuildTextChannel: boolean;
  session: ChannelSession | null;
};

type GuildCommandSessionResolver = (
  deps: Pick<GuildCommandRuntimeDeps, "getSession" | "getLiveSession">,
  interaction: ChatInputCommandInteraction,
  inGuildTextChannel: boolean,
) => Effect.Effect<ChannelSession | null, unknown>;

export type GuildCommand = {
  name: string;
  description: string;
  resolveSession: GuildCommandSessionResolver;
  execute: (context: GuildCommandExecutionContext) => Effect.Effect<boolean, unknown>;
};

const defineGuildCommand = <const T extends GuildCommand>(command: T) => command;

const replyToCommandInteraction = (interaction: ChatInputCommandInteraction, message: string) => {
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

const deferCommandInteraction = (interaction: ChatInputCommandInteraction) => {
  if (interaction.replied || interaction.deferred) {
    return Effect.void;
  }
  return Effect.promise(() => interaction.deferReply({ flags: MessageFlags.Ephemeral })).pipe(
    Effect.ignore,
  );
};

const editCommandInteraction = (interaction: ChatInputCommandInteraction, message: string) => {
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

const resolveLiveSession: GuildCommandSessionResolver = (deps, interaction, inGuildTextChannel) =>
  inGuildTextChannel ? deps.getLiveSession(interaction.channelId) : Effect.succeed(null);

const resolveRestoredSession: GuildCommandSessionResolver = (
  deps,
  interaction,
  inGuildTextChannel,
) => (inGuildTextChannel ? deps.getSession(interaction.channelId) : Effect.succeed(null));

const defineSessionCommand = <
  const TName extends string,
  const TDescription extends string,
>(input: {
  name: TName;
  description: TDescription;
  execute: GuildCommand["execute"];
}) =>
  defineGuildCommand({
    name: input.name,
    description: input.description,
    resolveSession: resolveRestoredSession,
    execute: input.execute,
  });

const defineLiveSessionCommand = <
  const TName extends string,
  const TDescription extends string,
>(input: {
  name: TName;
  description: TDescription;
  execute: GuildCommand["execute"];
}) =>
  defineGuildCommand({
    name: input.name,
    description: input.description,
    resolveSession: resolveLiveSession,
    execute: input.execute,
  });

const executeChannelSettingToggle =
  (setting: "showThinking" | "showCompactionSummaries", label: string): GuildCommand["execute"] =>
  (context) =>
    Effect.gen(function* () {
      if (!context.inGuildTextChannel) {
        yield* replyToCommandInteraction(context.interaction, GUILD_TEXT_COMMAND_ONLY_MESSAGE);
        return true;
      }

      const persistedSettings = yield* context.deps.getChannelSettings(
        context.interaction.channelId,
      );
      const currentSettings = resolveChannelSettings(
        context.deps.channelSettingsDefaults,
        persistedSettings,
      );
      const nextSettings: PersistedChannelSettings = {
        channelId: context.interaction.channelId,
        showThinking: persistedSettings?.showThinking,
        showCompactionSummaries: persistedSettings?.showCompactionSummaries,
      };
      nextSettings[setting] = !currentSettings[setting];

      yield* context.deps.upsertChannelSettings(nextSettings);

      const resolvedSettings = resolveChannelSettings(
        context.deps.channelSettingsDefaults,
        nextSettings,
      );
      if (context.session) {
        context.session.channelSettings = resolvedSettings;
      }

      yield* replyToCommandInteraction(
        context.interaction,
        `${label} are now ${resolvedSettings[setting] ? "enabled" : "disabled"} in this channel.`,
      );
      return true;
    });

const executeCompactSession: GuildCommand["execute"] = (context) =>
  Effect.gen(function* () {
    const compactEntry = decideCompactEntry({
      inGuildTextChannel: context.inGuildTextChannel,
      hasSession: !!context.session,
      hasActiveRun: !!context.session?.activeRun,
    });
    if (compactEntry.type === "reject") {
      yield* replyToCommandInteraction(context.interaction, compactEntry.message);
      return true;
    }

    yield* deferCommandInteraction(context.interaction);

    const session = context.session!;
    const compactHealthDecision = decideCompactAfterHealthCheck(
      yield* context.deps.isSessionHealthy(session.opencode),
    );
    if (compactHealthDecision.type === "reject-after-defer") {
      yield* editCommandInteraction(context.interaction, compactHealthDecision.message);
      return true;
    }

    const channel = context.interaction.channel as SendableChannels;
    yield* context.deps.beginIdleCompaction(session.opencode.sessionId);
    const existingCard = yield* context.deps.getIdleCompactionCard(session.opencode.sessionId);
    const compactingCard = compactionCardContent("compacting");
    const compactedCard = compactionCardContent("compacted");
    const compactionCard = yield* Effect.promise(() =>
      context.deps.upsertInfoCard({
        channel,
        existingCard,
        title: compactingCard.title,
        body: compactingCard.body,
      }),
    ).pipe(
      Effect.tap((card) => context.deps.setIdleCompactionCard(session.opencode.sessionId, card)),
      Effect.catchAll((error) =>
        context.deps.logger
          .warn("failed to post idle compaction card", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: context.deps.formatError(error),
          })
          .pipe(Effect.as(null)),
      ),
    );

    yield* context.deps.compactSession(session.opencode).pipe(
      Effect.tap(() =>
        context.deps.finalizeIdleCompactionCard(
          session.opencode.sessionId,
          compactedCard.title,
          compactedCard.body,
        ),
      ),
      Effect.tapError((error) =>
        context.deps.logger.error("failed to compact session", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          error: context.deps.formatError(error),
        }),
      ),
      Effect.catchAll((error) =>
        compactionCard
          ? context.deps.getIdleCompactionInterruptRequested(session.opencode.sessionId).pipe(
              Effect.flatMap((interruptRequested) =>
                interruptRequested
                  ? (() => {
                      const interruptedCard = compactionCardContent("interrupted");
                      return context.deps.finalizeIdleCompactionCard(
                        session.opencode.sessionId,
                        interruptedCard.title,
                        interruptedCard.body,
                      );
                    })()
                  : context.deps.finalizeIdleCompactionCard(
                      session.opencode.sessionId,
                      "❌ Session compaction failed",
                      `OpenCode could not compact this session.\n\n${context.deps.formatError(
                        error,
                      )}`,
                    ),
              ),
            )
          : Effect.void,
      ),
      Effect.forkDaemon,
    );

    yield* editCommandInteraction(
      context.interaction,
      "Started session compaction. I'll post updates in this channel.",
    );
    return true;
  });

const executeInterruptSession: GuildCommand["execute"] = (context) =>
  Effect.gen(function* () {
    const session = context.session;
    const interruptEntry = decideInterruptEntry({
      inGuildTextChannel: context.inGuildTextChannel,
      hasSession: !!session,
      hasActiveRun: !!session?.activeRun,
      hasIdleCompaction:
        session && !session.activeRun
          ? yield* context.deps.hasIdleCompaction(session.opencode.sessionId)
          : false,
    });
    if (interruptEntry.type === "reject") {
      yield* replyToCommandInteraction(context.interaction, interruptEntry.message);
      return true;
    }

    yield* deferCommandInteraction(context.interaction);

    if (interruptEntry.target === "compaction") {
      yield* context.deps.setIdleCompactionInterruptRequested(session!.opencode.sessionId, true);
      const interruptResult = yield* context.deps
        .interruptSession(session!.opencode)
        .pipe(Effect.either);
      if (interruptResult._tag === "Left") {
        yield* context.deps.setIdleCompactionInterruptRequested(session!.opencode.sessionId, false);
        yield* editCommandInteraction(
          context.interaction,
          formatErrorResponse(
            "## ❌ Failed to interrupt compaction",
            context.deps.formatError(interruptResult.left),
          ),
        );
        return true;
      }

      const interruptingCard = compactionCardContent("interrupting");
      yield* context.deps.updateIdleCompactionCard(
        session!.opencode.sessionId,
        interruptingCard.title,
        interruptingCard.body,
      );
      yield* editCommandInteraction(
        context.interaction,
        "Requested interruption of the active OpenCode compaction.",
      );
      return true;
    }

    const activeRun = session!.activeRun!;
    const rollbackInterruptRequest = beginInterruptRequest(activeRun);
    const interruptResult = yield* context.deps
      .interruptSession(session!.opencode)
      .pipe(Effect.either);
    if (interruptResult._tag === "Left") {
      rollbackInterruptRequest();
      yield* editCommandInteraction(
        context.interaction,
        formatErrorResponse(
          "## ❌ Failed to interrupt run",
          context.deps.formatError(interruptResult.left),
        ),
      );
      return true;
    }

    yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore);
    yield* Effect.promise(async () => {
      await context.deps.sendInfoCard(
        context.interaction.channel as SendableChannels,
        "‼️ Run interrupted",
        "OpenCode stopped the active run in this channel.",
      );
    }).pipe(
      Effect.catchAll((error) =>
        context.deps.logger.warn("failed to post interrupt info card", {
          channelId: session!.channelId,
          sessionId: session!.opencode.sessionId,
          error: context.deps.formatError(error),
        }),
      ),
      Effect.ignore,
    );
    yield* editCommandInteraction(context.interaction, "Interrupted the active OpenCode run.");
    return true;
  });

export const GUILD_COMMANDS = [
  defineSessionCommand({
    name: "compact",
    description: "Compact the current OpenCode session in this channel",
    execute: executeCompactSession,
  }),
  defineSessionCommand({
    name: "interrupt",
    description: "Interrupt the active OpenCode run in this channel",
    execute: executeInterruptSession,
  }),
  defineLiveSessionCommand({
    name: "toggle-thinking",
    description: "Toggle thinking progress messages in this channel",
    execute: executeChannelSettingToggle("showThinking", "Thinking messages"),
  }),
  defineLiveSessionCommand({
    name: "toggle-compaction-summaries",
    description: "Toggle compaction summaries in this channel",
    execute: executeChannelSettingToggle("showCompactionSummaries", "Compaction summaries"),
  }),
] as const;

export type GuildCommandName = (typeof GUILD_COMMANDS)[number]["name"];

const GUILD_COMMANDS_BY_NAME = new Map<GuildCommandName, (typeof GUILD_COMMANDS)[number]>(
  GUILD_COMMANDS.map((command) => [command.name, command]),
);

export const getGuildCommand = (name: string): GuildCommand | null =>
  GUILD_COMMANDS_BY_NAME.get(name as GuildCommandName) ?? null;

const SLASH_COMMAND_PAYLOADS = GUILD_COMMANDS.map((command) =>
  new SlashCommandBuilder().setName(command.name).setDescription(command.description).toJSON(),
);

export const syncGuildCommands = async (guild: Guild) => {
  await guild.commands.set(SLASH_COMMAND_PAYLOADS);
};
