import { ContainerBuilder, TextDisplayBuilder } from "@discordjs/builders";
import { MessageFlags, type Message, type SendableChannels } from "discord.js";
import type { ToolPart } from "@opencode-ai/sdk/v2";

import {
  formatStepLine,
  formatToolInputLines,
  renderToolCardLine,
  searchResultInfo,
  statusLine,
} from "./tool-card/formatters.ts";
import type { ToolCardPathContext, ToolCardTerminalState } from "./tool-card/types.ts";
import {
  formatDuration,
  formatStatus,
  singleLine,
  statusEmoji,
  toolEmoji,
  truncate,
} from "./tool-card/utils.ts";
import type { ResolvedSandboxBackend } from "@/sandbox/backend.ts";

const EDIT_TOOL_CARDS = true;

const pathContext = (workdir: string, backend: ResolvedSandboxBackend): ToolCardPathContext => ({
  workdir,
  backend,
});

const renderToolCard = (input: {
  part: ToolPart;
  pathContext: ToolCardPathContext;
  terminalState?: ToolCardTerminalState;
}) => {
  const { part, terminalState } = input;
  const duration = terminalState ? null : formatDuration(part);
  const statusLabel = duration
    ? `${formatStatus(part, terminalState)} in ${duration}`
    : formatStatus(part, terminalState);
  const header =
    part.tool === "todowrite"
      ? "**📝 Todo list**"
      : `**${toolEmoji(part.tool)} ${statusEmoji(part, terminalState)} \`${part.tool}\` ${statusLabel}**`;
  const lines = [header];

  const inputLines = formatToolInputLines(part, input.pathContext);
  if (inputLines.length > 0) {
    lines.push(...inputLines.map(renderToolCardLine));
  }

  const stepLine = formatStepLine(part);
  if (stepLine) {
    lines.push(renderToolCardLine(stepLine));
  }

  const resultInfo = searchResultInfo(part);
  if (resultInfo && "count" in resultInfo) {
    lines.push(renderToolCardLine(statusLine("Results", `\`${resultInfo.count}\``)));
  } else if (resultInfo && "error" in resultInfo) {
    lines.push(renderToolCardLine(statusLine("Results Error", `\`${resultInfo.error}\``)));
  }

  if (terminalState === "interrupted") {
    lines.push(
      renderToolCardLine(
        statusLine("Note", "This tool did not complete because the run was interrupted."),
      ),
    );
  } else if (part.state.status === "error") {
    lines.push(
      renderToolCardLine(statusLine("Error", `\`${truncate(singleLine(part.state.error), 600)}\``)),
    );
  }

  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join("\n")),
  );

  return [container];
};

const createPayload = (input: {
  part: ToolPart;
  pathContext: ToolCardPathContext;
  includeNotificationSuppression: boolean;
  terminalState?: ToolCardTerminalState;
}) => ({
  flags: input.includeNotificationSuppression
    ? MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications
    : MessageFlags.IsComponentsV2,
  components: renderToolCard({
    part: input.part,
    pathContext: input.pathContext,
    terminalState: input.terminalState,
  }),
  allowedMentions: { parse: [] as Array<never> },
});

export const upsertToolCard = async (input: {
  sourceMessage: Message;
  existingCard: Message | null;
  part: ToolPart;
  workdir: string;
  backend: ResolvedSandboxBackend;
  mode?: "edit-or-send" | "always-send";
  terminalState?: ToolCardTerminalState;
}) => {
  const mode = input.mode ?? "edit-or-send";
  if (mode === "edit-or-send" && EDIT_TOOL_CARDS && input.existingCard) {
    try {
      await input.existingCard.edit(
        createPayload({
          part: input.part,
          pathContext: pathContext(input.workdir, input.backend),
          includeNotificationSuppression: false,
          terminalState: input.terminalState,
        }),
      );
      return input.existingCard;
    } catch {
      // fall through and create a fresh card if the previous message was deleted/uneditable.
    }
  }

  if (!input.sourceMessage.channel.isSendable()) {
    throw new Error("Channel is not sendable for tool progress card");
  }

  return (input.sourceMessage.channel as SendableChannels).send(
    createPayload({
      part: input.part,
      pathContext: pathContext(input.workdir, input.backend),
      includeNotificationSuppression: true,
      terminalState: input.terminalState,
    }),
  );
};

export const editToolCard = (input: {
  card: Message;
  part: ToolPart;
  workdir: string;
  backend: ResolvedSandboxBackend;
  terminalState: ToolCardTerminalState;
}) =>
  input.card.edit(
    createPayload({
      part: input.part,
      pathContext: pathContext(input.workdir, input.backend),
      includeNotificationSuppression: false,
      terminalState: input.terminalState,
    }),
  );

export type { ToolCardTerminalState } from "./tool-card/types.ts";
