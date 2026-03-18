import { Effect, Layer, Ref, ServiceMap } from "effect";
import { type Interaction, type Message } from "discord.js";

import { AppConfig } from "@/config.ts";
import { createCommandHandler } from "@/sessions/command-handler.ts";
import { InfoCards } from "@/discord/info-cards.ts";
import { buildOpencodePrompt, promptMessageContext, startTypingLoop } from "@/discord/messages.ts";
import type { Invocation } from "@/discord/triggers.ts";
import { collectAttachmentMessages } from "@/sessions/message-context.ts";
import { SessionRuntime } from "@/sessions/session-runtime.ts";
import type { RunRequest } from "@/sessions/session.ts";
import { SessionStore } from "@/state/store.ts";
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
    const sessionRuntime = yield* SessionRuntime;
    const sessionStore = yield* SessionStore;
    const shutdownStartedRef = yield* Ref.make(false);

    const commandLayer = Layer.mergeAll(
      Layer.succeed(AppConfig, config),
      Layer.succeed(InfoCards, infoCards),
      Layer.succeed(SessionRuntime, sessionRuntime),
      Layer.succeed(SessionStore, sessionStore),
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

                      const queued = yield* sessionRuntime.queueMessageRunRequest(
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
                  ? sessionRuntime.routeQuestionInteraction(interaction)
                  : Effect.void,
          ),
        ),
      shutdown: () =>
        Ref.modify(shutdownStartedRef, (started): readonly [boolean, boolean] =>
          started ? [false, true] : [true, true],
        ).pipe(
          Effect.flatMap((startedNow) => (startedNow ? sessionRuntime.shutdown() : Effect.void)),
        ),
    } satisfies ChannelRuntimeShape;

    return channelRuntime;
  }),
);
