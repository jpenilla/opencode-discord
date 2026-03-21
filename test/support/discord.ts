import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  type SendableChannels,
} from "discord.js";

import { unsafeStub } from "./stub.ts";

export const cardText = (payload: unknown) =>
  String(
    (payload as { components?: Array<{ components?: Array<{ data?: { content?: string } }> }> })
      .components?.[0]?.components?.[0]?.data?.content ?? "",
  );

export const makePostedMessage = (
  id: string,
  edit?: (payload: MessageEditOptions) => Promise<Message>,
): Message =>
  unsafeStub<Message>({
    id,
    edit: edit ?? (async () => makePostedMessage(id, edit)),
  });

export const makeSendableChannel = (input: {
  id?: string;
  type?: ChannelType;
  send?: (payload: MessageCreateOptions) => Promise<Message>;
  sendTyping?: () => Promise<void>;
}): SendableChannels =>
  unsafeStub<SendableChannels>({
    id: input.id ?? "channel-1",
    type: input.type ?? ChannelType.GuildText,
    isSendable: () => true,
    send:
      input.send ??
      (() =>
        Promise.reject(new Error("makeSendableChannel requires a send handler for this test"))),
    sendTyping: input.sendTyping ?? (() => Promise.resolve()),
  });

export const makeRecordedCommandInteraction = (input?: {
  commandName?: string;
  channelId?: string;
  channel?: SendableChannels;
  inGuild?: boolean;
  onReply?: (payload: unknown) => Promise<void>;
  onEditReply?: (payload: unknown) => Promise<void>;
  onDeferReply?: () => Promise<void>;
}) => {
  let defers = 0;

  const interaction = unsafeStub<
    ChatInputCommandInteraction & {
      replied: boolean;
      deferred: boolean;
      commandName: string;
    }
  >({
    channelId: input?.channelId ?? "channel-1",
    commandName: input?.commandName ?? "compact",
    channel:
      input?.channel ??
      makeSendableChannel({
        id: input?.channelId ?? "channel-1",
        type: ChannelType.GuildText,
      }),
    replied: false,
    deferred: false,
    inGuild: () => input?.inGuild ?? true,
    isChatInputCommand: () => true,
    reply: (payload: unknown) => {
      interaction.replied = true;
      return input?.onReply?.(payload) ?? Promise.resolve();
    },
    deferReply: () => {
      interaction.deferred = true;
      defers += 1;
      return input?.onDeferReply?.() ?? Promise.resolve();
    },
    editReply: (payload: unknown) => {
      return input?.onEditReply?.(payload) ?? Promise.resolve();
    },
  });

  return {
    interaction,
    readDefers: () => defers,
  };
};

export const makeRecordedComponentInteraction = (
  kind: "button" | "select" | "modal",
  input: {
    customId: string;
    userId?: string;
    messageId?: string;
    values?: string[];
    value?: string;
    update?: (payload: unknown) => Promise<Message>;
    followUp?: (payload: unknown) => Promise<Message>;
    showModal?: (payload: unknown) => Promise<void>;
    deferUpdate?: () => Promise<void>;
    onReply?: (payload: unknown) => Promise<void>;
    onUpdate?: (payload: unknown) => Promise<void>;
  },
) => {
  const requireAck = () => {
    if (!interaction.replied && !interaction.deferred) {
      throw new Error("followUp requires an acknowledged interaction");
    }
  };

  const interaction = unsafeStub<Interaction & { replied: boolean; deferred: boolean }>({
    customId: input.customId,
    values: input.values,
    user: { id: input.userId ?? "owner" },
    message: { id: input.messageId ?? "question-message" },
    replied: false,
    deferred: false,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => kind === "modal",
    isChatInputCommand: () => false,
    reply: (payload: unknown) => {
      interaction.replied = true;
      return input.onReply?.(payload) ?? Promise.resolve();
    },
    update: (payload: unknown) => {
      interaction.replied = true;
      const updated = input.onUpdate?.(payload) ?? Promise.resolve();
      return updated.then(
        () =>
          input.update?.(payload) ??
          Promise.resolve(makePostedMessage(input.messageId ?? "question-message")),
      );
    },
    followUp: (payload: unknown) => {
      requireAck();
      return (
        input.followUp?.(payload) ??
        Promise.resolve(makePostedMessage(input.messageId ?? "question-message"))
      );
    },
    showModal: (payload: unknown) => {
      interaction.replied = true;
      return input.showModal?.(payload) ?? Promise.resolve();
    },
    deferUpdate: () => {
      interaction.deferred = true;
      return input.deferUpdate?.() ?? Promise.resolve();
    },
    fields: {
      getTextInputValue: () => input.value ?? "",
    },
  });

  return interaction;
};
