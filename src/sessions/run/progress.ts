import { Deferred, Effect, Queue } from "effect";
import type { Message, SendableChannels } from "discord.js";
import type { ToolPart } from "@opencode-ai/sdk/v2";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import { editInfoCard, upsertInfoCard } from "@/discord/info-card.ts";
import { sendProgressUpdate } from "@/discord/messages.ts";
import { editToolCard, upsertToolCard } from "@/discord/tool-card/index.ts";
import { formatSessionStatus, formatThinkingCompleted } from "@/discord/progress.ts";
import type { ChannelSession, RunFinalizationReason, RunProgressEvent } from "@/sessions/types.ts";
import { ResolvedSandboxBackend } from "@/sandbox/common";
import { ChannelSettings } from "@/state/channel-settings";

export const maxProgressBatchSize = 65;

export const takeProgressBatch = (queue: Queue.Queue<RunProgressEvent>) =>
  Queue.takeBetween(queue, 1, maxProgressBatchSize);

const SKIPPED_TOOL_CARD_NAMES = new Set([
  "send-file",
  "send-image",
  "react",
  "list-attachments",
  "list-custom-emojis",
  "list-stickers",
  "send-sticker",
  "question",
]);

type ProgressState = {
  toolUpdateKeys: Map<string, string>;
  terminalToolCallIds: Set<string>;
  toolCards: Map<string, Message>;
  activeToolParts: Map<string, ToolPart>;
  todoCards: Message[];
  compaction: RunCompactionState;
  retryStatusKeys: Set<string>;
  completedReasoningPartIds: Set<string>;
};

type RunCompactionState =
  | { type: "inactive" }
  | { type: "active"; partIds: Set<string>; card: Message | null };

const inactiveRunCompaction = (): RunCompactionState => ({ type: "inactive" });

const createProgressState = (): ProgressState => ({
  toolUpdateKeys: new Map<string, string>(),
  terminalToolCallIds: new Set<string>(),
  toolCards: new Map<string, Message>(),
  activeToolParts: new Map<string, ToolPart>(),
  todoCards: [],
  compaction: inactiveRunCompaction(),
  retryStatusKeys: new Set<string>(),
  completedReasoningPartIds: new Set<string>(),
});

const isTodoTool = (tool: string) => tool === "todowrite";

const activeRunCompaction = (state: ProgressState) =>
  state.compaction.type === "active" ? state.compaction : null;

const beginRunCompaction = (state: ProgressState, partId: string) => {
  const current = activeRunCompaction(state);
  if (!current) {
    state.compaction = {
      type: "active",
      partIds: new Set([partId]),
      card: null,
    };
    return false;
  }

  if (current.partIds.has(partId)) {
    return true;
  }

  current.partIds.add(partId);
  return false;
};

const setRunCompactionCard = (state: ProgressState, card: Message) => {
  const current = activeRunCompaction(state);
  if (!current) {
    return;
  }

  current.card = card;
};

const clearRunCompaction = (state: ProgressState) => {
  state.compaction = inactiveRunCompaction();
};

const isTerminalToolPart = (part: ToolPart) =>
  part.state.status === "completed" || part.state.status === "error";

const toolUpdateKey = (part: ToolPart) => {
  const title =
    part.state.status === "running" || part.state.status === "completed" ? part.state.title : "";
  return `${part.state.status}:${title}`;
};

const shouldSkipToolUpdate = (
  state: ProgressState,
  event: Extract<RunProgressEvent, { type: "tool-updated" }>,
) => {
  if (SKIPPED_TOOL_CARD_NAMES.has(event.part.tool)) {
    return true;
  }
  if (isTodoTool(event.part.tool) && event.part.state.status !== "completed") {
    return true;
  }

  if (isTerminalToolPart(event.part) && state.terminalToolCallIds.has(event.part.callID)) {
    return true;
  }

  const nextKey = toolUpdateKey(event.part);
  const previousKey = state.toolUpdateKeys.get(event.part.callID);
  if (previousKey === nextKey) {
    return true;
  }

  state.toolUpdateKeys.set(event.part.callID, nextKey);
  if (isTerminalToolPart(event.part)) {
    state.terminalToolCallIds.add(event.part.callID);
  }
  return false;
};

const progressUpdateForEvent = (
  event: RunProgressEvent,
  state: ProgressState,
  channelSettings: ChannelSettings,
) => {
  switch (event.type) {
    case "run-finalizing":
      return null;
    case "reasoning-completed": {
      if (state.completedReasoningPartIds.has(event.partId)) {
        return null;
      }
      state.completedReasoningPartIds.add(event.partId);
      if (!channelSettings.showThinking) {
        return null;
      }
      const thinkingText = event.text.trim();
      if (thinkingText.length === 0) {
        return null;
      }
      return formatThinkingCompleted(thinkingText);
    }
    case "session-compacting":
    case "session-compacted":
      return null;
    case "session-status":
      if (event.status.type === "retry") {
        const key = `${event.status.attempt}:${event.status.message}`;
        if (state.retryStatusKeys.has(key)) {
          return null;
        }
        state.retryStatusKeys.add(key);
      }
      return formatSessionStatus(event.status);
  }
};

const deletePreviousTodoCards = (state: ProgressState, currentCard: Message) =>
  Effect.gen(function* () {
    for (const previousTodoCard of state.todoCards) {
      if (previousTodoCard.id === currentCard.id) {
        continue;
      }
      yield* Effect.promise(() => previousTodoCard.delete()).pipe(Effect.ignore);
    }
    state.todoCards = [currentCard];
  });

const trackLiveToolState = (state: ProgressState, part: ToolPart) => {
  if (part.state.status === "pending" || part.state.status === "running") {
    state.activeToolParts.set(part.callID, part);
    return;
  }

  state.activeToolParts.delete(part.callID);
};

const handleToolCard = (
  state: ProgressState,
  channel: SendableChannels,
  pathContext: {
    workdir: string;
    backend: ResolvedSandboxBackend;
  },
  event: Extract<RunProgressEvent, { type: "tool-updated" }>,
) =>
  Effect.gen(function* () {
    if (shouldSkipToolUpdate(state, event)) {
      return;
    }

    const todoTool = isTodoTool(event.part.tool);
    const existingCard = state.toolCards.get(event.part.callID) ?? null;
    const card = yield* upsertToolCard({
      channel,
      existingCard: todoTool ? null : existingCard,
      workdir: pathContext.workdir,
      backend: pathContext.backend,
      part: event.part,
      mode: todoTool ? "always-send" : "edit-or-send",
    });
    state.toolCards.set(event.part.callID, card);
    trackLiveToolState(state, event.part);

    if (todoTool) {
      yield* deletePreviousTodoCards(state, card);
    }
  });

const handleCompactionCard = (
  state: ProgressState,
  channel: SendableChannels,
  event: Extract<RunProgressEvent, { type: "session-compacting" | "session-compacted" }>,
) =>
  Effect.gen(function* () {
    if (event.type === "session-compacting") {
      if (beginRunCompaction(state, event.part.id)) {
        return;
      }
      const compactingCard = compactionCardContent("compacting");
      const current = activeRunCompaction(state);
      const card = yield* Effect.promise(() =>
        upsertInfoCard({
          channel,
          existingCard: current?.card ?? null,
          title: compactingCard.title,
          body: compactingCard.body,
        }),
      );
      setRunCompactionCard(state, card);
      return;
    }

    // session.compacted is only keyed by session id upstream, so a delayed event from an
    // earlier or aborted compaction attempt can arrive while an unrelated later run is active.
    // Only treat completion as relevant if this worker already observed the matching compaction.
    const current = activeRunCompaction(state);
    if (!current) {
      return;
    }

    const compactedCard = compactionCardContent("compacted");
    yield* Effect.promise(() =>
      upsertInfoCard({
        channel,
        existingCard: current.card,
        title: compactedCard.title,
        body: compactedCard.body,
      }),
    );
    clearRunCompaction(state);
  });

const finalizeLiveCards = (
  state: ProgressState,
  pathContext: { workdir: string; backend: ResolvedSandboxBackend },
  reason: RunFinalizationReason,
) =>
  Effect.gen(function* () {
    if (reason === "interrupted") {
      yield* Effect.forEach(
        state.activeToolParts.entries(),
        ([callId, part]) => {
          const card = state.toolCards.get(callId);
          if (!card) {
            return Effect.void;
          }

          return editToolCard({
            card,
            part,
            workdir: pathContext.workdir,
            backend: pathContext.backend,
            interrupted: true,
          }).pipe(Effect.ignore);
        },
        { concurrency: "unbounded", discard: true },
      );
    }

    state.activeToolParts.clear();

    const currentCompaction = activeRunCompaction(state);
    if (!currentCompaction?.card) {
      clearRunCompaction(state);
      return;
    }

    const { title, body } = compactionCardContent("interrupted");
    const card = currentCompaction.card;
    yield* Effect.promise(() => editInfoCard(card, title, body)).pipe(Effect.ignore);
    clearRunCompaction(state);
  });

export const runProgressWorker = (
  channel: SendableChannels,
  channelSession: Pick<ChannelSession, "channelSettings" | "opencode" | "workdir">,
  message: Message,
  queue: Queue.Queue<RunProgressEvent>,
): Effect.Effect<never, unknown> =>
  Effect.gen(function* () {
    const state = createProgressState();
    const pathContext = {
      workdir: channelSession.workdir,
      backend: channelSession.opencode.backend,
    } as const;

    while (true) {
      const batch = yield* takeProgressBatch(queue);

      for (const event of batch) {
        if (event.type === "run-finalizing") {
          progressUpdateForEvent(event, state, channelSession.channelSettings);
          if (event.reason) {
            yield* finalizeLiveCards(state, pathContext, event.reason);
          }
          yield* Deferred.succeed(event.ack, undefined).pipe(Effect.ignore);
          continue;
        }

        if (event.type === "tool-updated") {
          yield* handleToolCard(state, channel, pathContext, event);
          continue;
        }

        if (event.type === "session-compacting" || event.type === "session-compacted") {
          yield* handleCompactionCard(state, channel, event);
          continue;
        }

        const update = progressUpdateForEvent(event, state, channelSession.channelSettings);
        if (!update) {
          continue;
        }
        yield* Effect.promise(() => sendProgressUpdate(message, update));
      }
    }
  });
