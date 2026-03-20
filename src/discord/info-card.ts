import { ContainerBuilder, TextDisplayBuilder } from "@discordjs/builders";
import { MessageFlags, type Message, type SendableChannels } from "discord.js";
import { Effect, Layer, ServiceMap } from "effect";

export type InfoCardsShape = {
  send: (channel: SendableChannels, title: string, body: string) => Effect.Effect<Message, unknown>;
  edit: (card: Message, title: string, body: string) => Effect.Effect<void, unknown>;
  upsert: (input: {
    channel: SendableChannels;
    existingCard: Message | null;
    title: string;
    body: string;
  }) => Effect.Effect<Message, unknown>;
};

export class InfoCards extends ServiceMap.Service<InfoCards, InfoCardsShape>()("InfoCards") {}

const createInfoCardPayload = (title: string, body: string, suppressNotifications: boolean) => ({
  flags: suppressNotifications
    ? MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications
    : MessageFlags.IsComponentsV2,
  components: [
    new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**${title}**\n${body}`),
    ),
  ],
  allowedMentions: { parse: [] as Array<never> },
});

export const editInfoCard = (message: Message, title: string, body: string) =>
  message.edit(createInfoCardPayload(title, body, false));

export const sendInfoCard = (channel: SendableChannels, title: string, body: string) =>
  channel.send(createInfoCardPayload(title, body, true));

export const upsertInfoCard = async (input: {
  channel: SendableChannels;
  existingCard: Message | null;
  title: string;
  body: string;
}) => {
  if (input.existingCard) {
    try {
      await editInfoCard(input.existingCard, input.title, input.body);
      return input.existingCard;
    } catch {
      // Fall through and recreate the card if the previous message was deleted or can no longer be edited.
    }
  }

  return sendInfoCard(input.channel, input.title, input.body);
};

export const makeInfoCards = (): InfoCardsShape => ({
  send: (channel, title, body) =>
    Effect.promise(() => sendInfoCard(channel, title, body) as Promise<Message>),
  edit: (card, title, body) =>
    Effect.promise(() => editInfoCard(card, title, body)).pipe(Effect.asVoid),
  upsert: (input) => Effect.promise(() => upsertInfoCard(input) as Promise<Message>),
});

export const InfoCardsLayer = Layer.succeed(InfoCards, makeInfoCards());
