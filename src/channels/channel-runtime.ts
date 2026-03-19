import { Effect, Layer, Ref, ServiceMap } from "effect";
import { type Interaction, type Message } from "discord.js";

import {
  ChannelSettingsRuntime,
  makeChannelSettingsRuntime,
} from "@/channels/channel-settings-runtime.ts";
import { AppConfig } from "@/config.ts";
import { createCommandHandler } from "@/channels/command-handler.ts";
import { InfoCards } from "@/discord/info-cards.ts";
import { buildOpencodePrompt, promptMessageContext, startTypingLoop } from "@/discord/messages.ts";
import type { Invocation } from "@/discord/triggers.ts";
import { collectAttachmentMessages } from "@/sessions/message-context.ts";
import { SessionChannelBridge } from "@/sessions/session-runtime.ts";
import type { RunRequest } from "@/sessions/session.ts";
import { ChannelSettingsPersistence } from "@/state/persistence.ts";
import { Logger } from "@/util/logging.ts";

export type ChannelRuntimeShape = {
  submit: (message: Message, invocation: Invocation) => Effect.Effect<void, unknown>;
  handleInteraction: (interaction: Interaction) => Effect.Effect<void, unknown>;
  shutdown: () => Effect.Effect<void, unknown>;
};

export class ChannelRuntime extends ServiceMap.Service<ChannelRuntime, ChannelRuntimeShape>()(
  "ChannelRuntime",
) {}

type FallibleEffect<A> = Effect.Effect<A, unknown>;

export const ChannelRuntimeLayer = Layer.effect(
  ChannelRuntime,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const logger = yield* Logger;
    const infoCards = yield* InfoCards;
    const sessionBridge = yield* SessionChannelBridge;
    const channelSettingsPersistence = yield* ChannelSettingsPersistence;
    const shutdownStartedRef = yield* Ref.make(false);
    const channelSettings = makeChannelSettingsRuntime({
      defaults: {
        showThinking: config.showThinkingByDefault,
        showCompactionSummaries: config.showCompactionSummariesByDefault,
      },
      getPersistedChannelSettings: channelSettingsPersistence.getChannelSettings,
      upsertPersistedChannelSettings: channelSettingsPersistence.upsertChannelSettings,
      updateLoadedChannelSettings: sessionBridge.updateLoadedChannelSettings,
    });

    const commandLayer = Layer.mergeAll(
      Layer.succeed(ChannelSettingsRuntime, channelSettings),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(SessionChannelBridge, sessionBridge),
      Layer.succeed(Logger, logger),
    );
    const commandHandler = createCommandHandler({
      commandLayer,
    });

    const channelRuntime = {
      submit: (message, invocation): FallibleEffect<void> =>
        Ref.get(shutdownStartedRef).pipe(
          Effect.flatMap((shutdownStarted) =>
            shutdownStarted
              ? Effect.void
              : Effect.acquireUseRelease(
                  Effect.sync(() => startTypingLoop(message.channel)),
                  () =>
                    Effect.gen(function* () {
                      const attachmentMessages = yield* collectAttachmentMessages(message);
                      const referencedMessage =
                        attachmentMessages.find((candidate) => candidate.id !== message.id) ?? null;
                      const prompt = buildOpencodePrompt({
                        message: promptMessageContext(message, invocation.prompt),
                        referencedMessage: referencedMessage
                          ? promptMessageContext(referencedMessage)
                          : undefined,
                      });

                      const request = {
                        message,
                        prompt,
                        attachmentMessages,
                      } satisfies RunRequest;

                      const queued = yield* sessionBridge.queueMessageRunRequest(
                        message,
                        request,
                        "health probe failed before queueing run",
                      );
                      if (queued.destination === "follow-up") {
                        yield* logger.info("queued follow-up on active run", {
                          channelId: message.channelId,
                          sessionId: queued.sessionId,
                          author: message.author.tag,
                        });
                      } else {
                        yield* logger.info("queued run", {
                          channelId: message.channelId,
                          sessionId: queued.sessionId,
                          author: message.author.tag,
                        });
                      }
                    }),
                  (typing) => Effect.promise(() => typing.stop()).pipe(Effect.ignore),
                ),
          ),
        ),
      handleInteraction: (interaction) =>
        Ref.get(shutdownStartedRef).pipe(
          Effect.flatMap((shutdownStarted) =>
            shutdownStarted
              ? Effect.void
              : interaction.isChatInputCommand()
                ? commandHandler.handleInteraction(interaction)
                : interaction.isButton() ||
                    interaction.isStringSelectMenu() ||
                    interaction.isModalSubmit()
                  ? sessionBridge.routeQuestionInteraction(interaction)
                  : Effect.void,
          ),
        ),
      shutdown: () =>
        Ref.modify(shutdownStartedRef, (started): readonly [boolean, boolean] =>
          started ? [false, true] : [true, true],
        ).pipe(
          Effect.flatMap((startedNow) => (startedNow ? sessionBridge.shutdown() : Effect.void)),
        ),
    } satisfies ChannelRuntimeShape;

    return channelRuntime;
  }),
);
