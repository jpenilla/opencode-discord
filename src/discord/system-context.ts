import { ChannelType, type Message } from "discord.js";

export const buildSessionSystemAppend = (input: {
  message: Message;
  additionalInstructions: string;
}) => {
  const sections: string[] = [];
  const additionalInstructions = input.additionalInstructions.trim();
  if (additionalInstructions) {
    sections.push("Additional instructions:");
    sections.push(additionalInstructions);
  }

  if (input.message.inGuild() && input.message.channel.type === ChannelType.GuildText) {
    const topic = input.message.channel.topic?.trim();
    const context = [
      "Discord thread context:",
      `- Server: ${input.message.guild.name} (ID: ${input.message.guildId})`,
      `- Channel: #${input.message.channel.name} (ID: ${input.message.channelId})`,
      ...(topic ? [`- Channel topic: ${topic}`] : []),
    ];
    if (sections.length > 0) {
      sections.push("");
    }
    sections.push(...context);
  }

  const text = sections.join("\n").trim();
  return text.length > 0 ? text : undefined;
};
