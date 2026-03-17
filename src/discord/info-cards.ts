import type { Message, SendableChannels } from "discord.js";
import { Effect, ServiceMap } from "effect";

import { editInfoCard, sendInfoCard, upsertInfoCard } from "@/discord/info-card.ts";

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

export const makeInfoCards = (): InfoCardsShape => ({
  send: (channel, title, body) =>
    Effect.promise(() => sendInfoCard(channel, title, body) as Promise<Message>),
  edit: (card, title, body) =>
    Effect.promise(() => editInfoCard(card, title, body)).pipe(Effect.asVoid),
  upsert: (input) => Effect.promise(() => upsertInfoCard(input) as Promise<Message>),
});
