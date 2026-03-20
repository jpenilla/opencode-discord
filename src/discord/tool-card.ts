import { ContainerBuilder, TextDisplayBuilder } from "@discordjs/builders";
import { MessageFlags, type Message, type SendableChannels } from "discord.js";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import { Data, Effect } from "effect";

import {
  formatStepLine,
  formatToolInputLines,
  renderToolCardLine,
  searchResultInfo,
  statusLine,
} from "./tool-card/formatters.ts";
import { makeToolCardPathDisplay } from "./tool-card/path-display.ts";
import type { ToolCardPathDisplay } from "./tool-card/types.ts";
import {
  formatDuration,
  formatStatus,
  singleLine,
  statusEmoji,
  toolEmoji,
  truncate,
} from "./tool-card/utils.ts";
import type { ResolvedSandboxBackend } from "@/sandbox/common.ts";

const EDIT_TOOL_CARDS = true;

class ToolCardSendFailed extends Data.TaggedError("ToolCardSendFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const toolCardSendFailed = (message: string, cause?: unknown) =>
  new ToolCardSendFailed({ message, cause });

const renderToolCard = (input: {
  part: ToolPart;
  pathDisplay: ToolCardPathDisplay;
  interrupted?: boolean;
}) => {
  const { part, interrupted = false } = input;
  const duration = interrupted ? null : formatDuration(part);
  const statusLabel = duration
    ? `${formatStatus(part, interrupted)} in ${duration}`
    : formatStatus(part, interrupted);
  const header =
    part.tool === "todowrite"
      ? "**📝 Todo list**"
      : `**${toolEmoji(part.tool)} ${statusEmoji(part, interrupted)} \`${part.tool}\` ${statusLabel}**`;
  const lines = [header];

  const inputLines = formatToolInputLines(part, input.pathDisplay);
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

  if (interrupted) {
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

  return new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join("\n")),
  );
};

const createPayload = (input: {
  part: ToolPart;
  pathDisplay: ToolCardPathDisplay;
  suppressNotifications: boolean;
  interrupted?: boolean;
}) => ({
  flags: input.suppressNotifications
    ? MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications
    : MessageFlags.IsComponentsV2,
  components: [renderToolCard(input)],
  allowedMentions: { parse: [] as Array<never> },
});

export const upsertToolCard = (input: {
  channel: SendableChannels;
  existingCard: Message | null;
  part: ToolPart;
  workdir: string;
  backend: ResolvedSandboxBackend;
  mode?: "edit-or-send" | "always-send";
  interrupted?: boolean;
}) =>
  Effect.gen(function* () {
    const mode = input.mode ?? "edit-or-send";
    const pathDisplay = makeToolCardPathDisplay({
      workdir: input.workdir,
      backend: input.backend,
    });
    const existingCard = input.existingCard;

    if (mode === "edit-or-send" && EDIT_TOOL_CARDS && existingCard) {
      const payload = createPayload({
        part: input.part,
        pathDisplay,
        suppressNotifications: false,
        interrupted: input.interrupted,
      });
      const updated = yield* Effect.tryPromise({
        try: () => existingCard.edit(payload),
        catch: (cause) => toolCardSendFailed("Failed to edit tool progress card", cause),
      }).pipe(
        Effect.as(existingCard),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (updated) {
        return updated;
      }
    }

    const payload = createPayload({
      part: input.part,
      pathDisplay,
      suppressNotifications: true,
      interrupted: input.interrupted,
    });
    return yield* Effect.tryPromise({
      try: () => input.channel.send(payload) as Promise<Message>,
      catch: (cause) => toolCardSendFailed("Failed to send tool progress card", cause),
    });
  });

export const editToolCard = (input: {
  card: Message;
  part: ToolPart;
  workdir: string;
  backend: ResolvedSandboxBackend;
  interrupted: boolean;
}) =>
  Effect.gen(function* () {
    const payload = createPayload({
      part: input.part,
      pathDisplay: makeToolCardPathDisplay({
        workdir: input.workdir,
        backend: input.backend,
      }),
      suppressNotifications: false,
      interrupted: input.interrupted,
    });
    return yield* Effect.tryPromise({
      try: () => input.card.edit(payload),
      catch: (cause) => toolCardSendFailed("Failed to edit tool progress card", cause),
    });
  });
