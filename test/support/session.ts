import type { Message } from "discord.js";
import { Effect, Queue, Ref } from "effect";

import type {
  SessionCompactionInterruptResult,
  SessionCompactionStartResult,
  SessionCompactionWorkflow,
} from "@/sessions/compaction/workflow.ts";
import { createPromptState } from "@/sessions/run/prompt/state.ts";
import {
  noQuestionOutcome,
  type ActiveRun,
  type ChannelSession,
  type RunRequest,
  type RunProgressEvent,
} from "@/sessions/types.ts";
import { makeMessage, makeSessionHandle } from "./fixtures.ts";
import { unsafeStub } from "./stub.ts";

const makeSessionCompactionWorkflow = (): SessionCompactionWorkflow =>
  unsafeStub<SessionCompactionWorkflow>({
    hasActive: () => Effect.succeed(false),
    awaitCompletion: () => Effect.void,
    start: () =>
      Effect.succeed<SessionCompactionStartResult>({
        type: "rejected",
        message: "unexpected compaction start",
      }),
    requestInterrupt: () =>
      Effect.succeed<SessionCompactionInterruptResult>({
        type: "failed",
        message: "unexpected compaction interrupt",
      }),
    handleCompacted: () => Effect.void,
    handleInterrupted: () => Effect.void,
    emitSummary: () => Effect.void,
    shutdown: () => Effect.void,
  });

export const makeRunMessage = (id: string): Message =>
  makeMessage({
    id,
    channelId: "channel-1",
    channel: { id: "channel-1", isSendable: () => true },
  });

export const makeTestSession = (overrides: Partial<ChannelSession> = {}): ChannelSession =>
  unsafeStub<ChannelSession>({
    channelId: "channel-1",
    opencode: makeSessionHandle(),
    rootDir: "/tmp/session-root",
    workdir: "/home/opencode/workspace",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    channelSettings: {
      showThinking: true,
      showCompactionSummaries: true,
    },
    progressChannel: null,
    progressMentionContext: null,
    emittedCompactionSummaryMessageIds: new Set<string>(),
    compactionWorkflow: makeSessionCompactionWorkflow(),
    queue: Effect.runSync(Queue.unbounded<RunRequest>()),
    activeRun: null,
    ...overrides,
  });

export const makeTestActiveRun = async (
  overrides: Partial<ActiveRun> = {},
): Promise<{ activeRun: ActiveRun; progressQueue: Queue.Queue<RunProgressEvent> }> => {
  const progressQueue = overrides.progressQueue ?? (await Effect.runPromise(Queue.unbounded()));
  const promptState = overrides.promptState ?? (await Effect.runPromise(createPromptState()));
  const followUpQueue = overrides.followUpQueue ?? (await Effect.runPromise(Queue.unbounded()));
  const acceptFollowUps = overrides.acceptFollowUps ?? (await Effect.runPromise(Ref.make(true)));
  const activeRun = unsafeStub<ActiveRun>({
    originMessage: makeRunMessage("discord-message"),
    workdir: "/home/opencode/workspace",
    attachmentMessagesById: new Map(),
    currentPromptContext: null,
    previousPromptMessageIds: new Set<string>(),
    currentPromptMessageIds: new Set<string>(),
    currentPromptUserMessageId: null,
    assistantMessageParentIds: new Map<string, string>(),
    observedToolCallIds: new Set<string>(),
    progressQueue,
    promptState,
    followUpQueue,
    acceptFollowUps,
    typing: {
      pause: () => Promise.resolve(),
      resume: () => {},
      stop: () => Promise.resolve(),
    },
    finalizeProgress: () => Effect.void,
    questionWorkflow: null,
    questionOutcome: noQuestionOutcome(),
    interruptRequested: false,
    interruptSource: null,
    ...overrides,
  });
  return { activeRun, progressQueue };
};

export const makeTestSessionState = async (input?: {
  withActiveRun?: boolean;
  session?: Partial<ChannelSession>;
  activeRun?: Partial<ActiveRun>;
}) => {
  const activeRunState =
    input?.withActiveRun === false ? null : await makeTestActiveRun(input?.activeRun);
  const activeRun = activeRunState?.activeRun ?? null;
  const progressQueue =
    activeRunState?.progressQueue ?? (await Effect.runPromise(Queue.unbounded<RunProgressEvent>()));

  return {
    session: makeTestSession({
      activeRun,
      ...input?.session,
    }),
    activeRun,
    progressQueue,
    promptState: activeRun?.promptState ?? (await Effect.runPromise(createPromptState())),
  };
};
