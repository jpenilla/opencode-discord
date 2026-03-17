import { Deferred, Effect, Queue } from "effect";
import type { Message, SendableChannels } from "discord.js";
import type { ToolPart } from "@opencode-ai/sdk/v2";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import { editInfoCard, upsertInfoCard } from "@/discord/info-card.ts";
import { sendProgressUpdate } from "@/discord/messages.ts";
import { editToolCard, upsertToolCard } from "@/discord/tool-card.ts";
import {
  formatPatchUpdated,
  formatSessionStatus,
  formatThinkingCompleted,
} from "@/discord/progress.ts";
import type {
  ChannelSession,
  RunFinalizationReason,
  RunProgressEvent,
} from "@/sessions/session.ts";

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
  patchPartIds: Set<string>;
  toolUpdateKeys: Map<string, string>;
  terminalToolCallIds: Set<string>;
  toolCards: Map<string, Message>;
  activeToolParts: Map<string, ToolPart>;
  todoCards: Message[];
  compactionCard: Message | null;
  compactionPartIds: Set<string>;
  retryStatusKeys: Set<string>;
  completedReasoningPartIds: Set<string>;
};

const createProgressState = (): ProgressState => ({
  patchPartIds: new Set<string>(),
  toolUpdateKeys: new Map<string, string>(),
  terminalToolCallIds: new Set<string>(),
  toolCards: new Map<string, Message>(),
  activeToolParts: new Map<string, ToolPart>(),
  todoCards: [],
  compactionCard: null,
  compactionPartIds: new Set<string>(),
  retryStatusKeys: new Set<string>(),
  completedReasoningPartIds: new Set<string>(),
});

const isTodoTool = (tool: string) => tool === "todowrite";

const hasLiveCompaction = (state: ProgressState) =>
  state.compactionCard !== null || state.compactionPartIds.size > 0;

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
  session: Pick<ChannelSession, "channelSettings">,
) => {
  switch (event.type) {
    case "run-finalizing":
      return null;
    case "reasoning-completed": {
      if (state.completedReasoningPartIds.has(event.partId)) {
        return null;
      }
      state.completedReasoningPartIds.add(event.partId);
      if (!session.channelSettings.showThinking) {
        return null;
      }
      const thinkingText = event.text.trim();
      if (thinkingText.length === 0) {
        return null;
      }
      return formatThinkingCompleted(thinkingText);
    }
    case "patch-updated": {
      if (state.patchPartIds.has(event.part.id)) {
        return null;
      }
      state.patchPartIds.add(event.part.id);
      return formatPatchUpdated(event.part);
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
  message: Message,
  pathContext: { workdir: string; backend: ChannelSession["opencode"]["backend"] },
  event: Extract<RunProgressEvent, { type: "tool-updated" }>,
) =>
  Effect.gen(function* () {
    if (shouldSkipToolUpdate(state, event)) {
      return;
    }

    const todoTool = isTodoTool(event.part.tool);
    const existingCard = state.toolCards.get(event.part.callID) ?? null;
    const card = yield* Effect.promise(() =>
      upsertToolCard({
        sourceMessage: message,
        existingCard: todoTool ? null : existingCard,
        workdir: pathContext.workdir,
        backend: pathContext.backend,
        part: event.part,
        mode: todoTool ? "always-send" : "edit-or-send",
      }),
    );
    state.toolCards.set(event.part.callID, card);
    trackLiveToolState(state, event.part);

    if (todoTool) {
      yield* deletePreviousTodoCards(state, card);
    }
  });

const handleCompactionCard = (
  state: ProgressState,
  message: Message,
  event: Extract<RunProgressEvent, { type: "session-compacting" | "session-compacted" }>,
) =>
  Effect.gen(function* () {
    if (!message.channel.isSendable()) {
      throw new Error("Channel is not sendable for compaction card");
    }
    const channel = message.channel as SendableChannels;

    if (event.type === "session-compacting") {
      if (state.compactionPartIds.has(event.part.id)) {
        return;
      }
      state.compactionPartIds.add(event.part.id);
      const compactingCard = compactionCardContent("compacting");
      state.compactionCard = yield* Effect.promise(() =>
        upsertInfoCard({
          channel,
          existingCard: state.compactionCard,
          title: compactingCard.title,
          body: compactingCard.body,
        }),
      );
      return;
    }

    // session.compacted is only keyed by session id upstream, so a delayed event from an
    // earlier or aborted compaction attempt can arrive while an unrelated later run is active.
    // Only treat completion as relevant if this worker already observed the matching compaction.
    if (!hasLiveCompaction(state)) {
      return;
    }

    const compactedCard = compactionCardContent("compacted");
    yield* Effect.promise(() =>
      upsertInfoCard({
        channel,
        existingCard: state.compactionCard,
        title: compactedCard.title,
        body: compactedCard.body,
      }),
    );
    state.compactionPartIds.clear();
    state.compactionCard = null;
  });

const finalizeLiveCards = (
  state: ProgressState,
  pathContext: { workdir: string; backend: ChannelSession["opencode"]["backend"] },
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

          return Effect.promise(() =>
            editToolCard({
              card,
              part,
              workdir: pathContext.workdir,
              backend: pathContext.backend,
              terminalState: "interrupted",
            }),
          ).pipe(Effect.ignore);
        },
        { concurrency: "unbounded", discard: true },
      );
    }

    state.activeToolParts.clear();
    state.compactionPartIds.clear();

    if (!state.compactionCard) {
      return;
    }

    const { title, body } = compactionCardContent("interrupted");
    yield* Effect.promise(() => editInfoCard(state.compactionCard!, title, body)).pipe(
      Effect.ignore,
    );
    state.compactionCard = null;
  });

export const runProgressWorker = (
  session: Pick<ChannelSession, "channelSettings" | "opencode">,
  message: Message,
  workdir: string,
  queue: Queue.Queue<RunProgressEvent>,
): Effect.Effect<never, unknown> =>
  Effect.gen(function* () {
    const state = createProgressState();
    const pathContext = {
      workdir,
      backend: session.opencode.backend,
    } as const;

    while (true) {
      const batch = yield* takeProgressBatch(queue);

      for (const event of batch) {
        if (event.type === "run-finalizing") {
          progressUpdateForEvent(event, state, session);
          if (event.reason) {
            yield* finalizeLiveCards(state, pathContext, event.reason);
          }
          yield* Deferred.succeed(event.ack, undefined).pipe(Effect.ignore);
          continue;
        }

        if (event.type === "tool-updated") {
          yield* handleToolCard(state, message, pathContext, event);
          continue;
        }

        if (event.type === "session-compacting" || event.type === "session-compacted") {
          yield* handleCompactionCard(state, message, event);
          continue;
        }

        const update = progressUpdateForEvent(event, state, session);
        if (!update) {
          continue;
        }
        yield* Effect.promise(() => sendProgressUpdate({ message, text: update }));
      }
    }
  });
