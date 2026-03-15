import { describe, expect, test } from "bun:test";
import type { Message } from "discord.js";
import { Deferred, Effect, Queue, Ref } from "effect";

import type { PromptResult, SessionHandle } from "@/opencode/service.ts";
import { executeRunBatch } from "@/sessions/run-executor.ts";
import type { NonEmptyRunRequestBatch } from "@/sessions/run-batch.ts";
import type { ActiveRun, ChannelSession, RunProgressEvent } from "@/sessions/session.ts";
import { unsafeStub } from "../support/stub.ts";

const makeMessage = (id: string) =>
  unsafeStub<Message>({
    id,
    channelId: "channel-1",
    channel: { id: "channel-1" },
    attachments: new Map(),
  });

const makeSessionHandle = (): SessionHandle =>
  unsafeStub<SessionHandle>({
    sessionId: "session-1",
    client: {},
    workdir: "/home/opencode/workspace",
    backend: "bwrap",
    close: () => Effect.void,
  });

const makeSession = (): ChannelSession =>
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
    queue: {},
    activeRun: null,
  });

const makeInitialRequests = (message: Message): NonEmptyRunRequestBatch => [
  {
    message,
    prompt: "hello",
    attachmentMessages: [message],
  },
];

const makeRuntime = async (options?: {
  promptResult?: PromptResult;
  promptFailure?: unknown;
  progressBehavior?: "ack" | "exit";
  configureActiveRun?: (activeRun: ActiveRun) => void;
}) => {
  const calls = await Effect.runPromise(Ref.make<string[]>([]));
  const finalResponseMessageIds = await Effect.runPromise(Ref.make<string[]>([]));
  const questionUiFailureMessageIds = await Effect.runPromise(Ref.make<string[]>([]));
  const runFailureMessageIds = await Effect.runPromise(Ref.make<string[]>([]));
  const record = (entry: string) => Ref.update(calls, (current) => [...current, entry]);

  return {
    calls,
    finalResponseMessageIds,
    questionUiFailureMessageIds,
    runFailureMessageIds,
    runtime: {
      runPrompts: ({ activeRun }: { activeRun: ActiveRun }) =>
        Effect.gen(function* () {
          yield* record("runPrompts");
          options?.configureActiveRun?.(activeRun);
          if (options?.promptFailure) {
            return yield* Effect.fail(options.promptFailure);
          }
          return options?.promptResult ?? { messageId: "msg-1", transcript: "final transcript" };
        }),
      runProgressWorker: (
        _session: ChannelSession,
        _message: Message,
        _workdir: string,
        queue: Queue.Queue<RunProgressEvent>,
      ) => {
        if (options?.progressBehavior === "exit") {
          return record("progress:exit");
        }

        return Effect.forever(
          Queue.take(queue).pipe(
            Effect.flatMap((event) => {
              if (event.type === "run-finalizing") {
                return record("progress:run-finalizing").pipe(
                  Effect.zipRight(Deferred.succeed(event.ack, undefined).pipe(Effect.ignore)),
                );
              }
              return record("progress:event");
            }),
          ),
        );
      },
      startTyping: () => {
        Effect.runSync(record("typing:start"));
        return {
          pause: async () => {},
          resume: () => {},
          stop: async () => {
            Effect.runSync(record("typing:stop"));
          },
        };
      },
      setActiveRun: (session: ChannelSession, activeRun: ActiveRun | null) =>
        Effect.sync(() => {
          session.activeRun = activeRun;
        }).pipe(Effect.zipRight(record(`setActiveRun:${activeRun ? "active" : "null"}`))),
      terminateQuestionBatches: (sessionId: string) =>
        record(`terminateQuestionBatches:${sessionId}:expired`),
      ensureSessionHealthAfterFailure: (_session: ChannelSession, _responseMessage: Message) =>
        record("ensureSessionHealthAfterFailure"),
      sendRunInterruptedInfo: (_message: Message) => record("sendRunInterruptedInfo"),
      sendFinalResponse: (message: Message, text: string) =>
        Ref.update(finalResponseMessageIds, (current) => [...current, message.id]).pipe(
          Effect.zipRight(record(`sendFinalResponse:${text}`)),
        ),
      sendRunFailure: (message: Message, error: unknown) =>
        Ref.update(runFailureMessageIds, (current) => [...current, message.id]).pipe(
          Effect.zipRight(
            record(`sendRunFailure:${error instanceof Error ? error.message : String(error)}`),
          ),
        ),
      sendQuestionUiFailure: (message: Message, error: unknown) =>
        Ref.update(questionUiFailureMessageIds, (current) => [...current, message.id]).pipe(
          Effect.zipRight(record(`sendQuestionUiFailure:${String(error)}`)),
        ),
      logger: {
        info: (message: string) => record(`info:${message}`),
        warn: (message: string) => record(`warn:${message}`),
        error: (message: string) => record(`error:${message}`),
      },
      formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    } as const,
  };
};

describe("executeRunBatch", () => {
  test("runs a successful batch through progress finalization and final reply", async () => {
    const session = makeSession();
    const responseMessage = makeMessage("m-1");
    const initialRequests = makeInitialRequests(responseMessage);
    const { runtime, calls } = await makeRuntime();

    await Effect.runPromise(executeRunBatch(runtime)(session, initialRequests));

    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "typing:start",
      "setActiveRun:active",
      "runPrompts",
      "typing:stop",
      "progress:run-finalizing",
      "sendFinalResponse:final transcript",
      "info:completed run",
      "typing:stop",
      "terminateQuestionBatches:session-1:expired",
      "setActiveRun:null",
    ]);
    expect(session.activeRun).toBeNull();
  });

  test("sends the final Discord reply against the current prompt reply target", async () => {
    const session = makeSession();
    const originMessage = makeMessage("trigger-message");
    const replyTargetMessage = makeMessage("follow-up-message");
    const initialRequests = makeInitialRequests(originMessage);
    const { runtime, finalResponseMessageIds } = await makeRuntime({
      promptResult: {
        messageId: "assistant-after-auto-compaction",
        transcript: "final transcript",
      },
      configureActiveRun: (activeRun) => {
        activeRun.currentPromptContext = {
          kind: "follow-up",
          prompt: "follow-up",
          replyTargetMessage,
          requestMessages: [replyTargetMessage],
        };
      },
    });

    await Effect.runPromise(executeRunBatch(runtime)(session, initialRequests));

    expect(await Effect.runPromise(Ref.get(finalResponseMessageIds))).toEqual([
      "follow-up-message",
    ]);
  });

  test("sends the question UI failure reply for empty transcripts with an unnotified UI failure", async () => {
    const session = makeSession();
    const responseMessage = makeMessage("m-1");
    const initialRequests = makeInitialRequests(responseMessage);
    const replyTargetMessage = makeMessage("question-target");
    const { runtime, calls, questionUiFailureMessageIds } = await makeRuntime({
      promptResult: { messageId: "msg-1", transcript: "" },
      configureActiveRun: (activeRun) => {
        activeRun.currentPromptContext = {
          kind: "follow-up",
          prompt: "follow-up",
          replyTargetMessage,
          requestMessages: [replyTargetMessage],
        };
        activeRun.questionOutcome = {
          _tag: "ui-failure",
          message: "question failed",
          notified: false,
        };
      },
    });

    await Effect.runPromise(executeRunBatch(runtime)(session, initialRequests));

    const seen = await Effect.runPromise(Ref.get(calls));
    expect(seen).toContain("sendQuestionUiFailure:question failed");
    expect(seen.some((entry) => entry.startsWith("sendFinalResponse:"))).toBe(false);
    expect(await Effect.runPromise(Ref.get(questionUiFailureMessageIds))).toEqual([
      "question-target",
    ]);
  });

  test("sends a run failure and triggers health recovery after non-interrupt errors", async () => {
    const session = makeSession();
    const responseMessage = makeMessage("m-1");
    const initialRequests = makeInitialRequests(responseMessage);
    const replyTargetMessage = makeMessage("failure-target");
    const { runtime, calls, runFailureMessageIds } = await makeRuntime({
      promptFailure: new Error("boom"),
      configureActiveRun: (activeRun) => {
        activeRun.currentPromptContext = {
          kind: "follow-up",
          prompt: "follow-up",
          replyTargetMessage,
          requestMessages: [replyTargetMessage],
        };
      },
    });

    await Effect.runPromise(executeRunBatch(runtime)(session, initialRequests));

    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "typing:start",
      "setActiveRun:active",
      "runPrompts",
      "error:run failed",
      "typing:stop",
      "sendRunFailure:boom",
      "typing:stop",
      "terminateQuestionBatches:session-1:expired",
      "setActiveRun:null",
      "ensureSessionHealthAfterFailure",
    ]);
    expect(await Effect.runPromise(Ref.get(runFailureMessageIds))).toEqual(["failure-target"]);
  });

  test("suppresses run failure and health recovery when the run was intentionally interrupted", async () => {
    const session = makeSession();
    const responseMessage = makeMessage("m-1");
    const initialRequests = makeInitialRequests(responseMessage);
    const { runtime, calls } = await makeRuntime({
      promptFailure: new Error("interrupted"),
      configureActiveRun: (activeRun) => {
        activeRun.interruptRequested = true;
      },
    });

    await Effect.runPromise(executeRunBatch(runtime)(session, initialRequests));

    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "typing:start",
      "setActiveRun:active",
      "runPrompts",
      "info:interrupted run",
      "typing:stop",
      "progress:run-finalizing",
      "sendRunInterruptedInfo",
      "typing:stop",
      "terminateQuestionBatches:session-1:expired",
      "setActiveRun:null",
    ]);
  });

  test("clears a stale interrupt request when the run still completes successfully", async () => {
    const session = makeSession();
    const responseMessage = makeMessage("m-1");
    const initialRequests = makeInitialRequests(responseMessage);
    const { runtime, calls } = await makeRuntime({
      configureActiveRun: (activeRun) => {
        activeRun.interruptRequested = true;
      },
    });

    await Effect.runPromise(executeRunBatch(runtime)(session, initialRequests));

    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "typing:start",
      "setActiveRun:active",
      "runPrompts",
      "warn:interrupt request did not stop run",
      "typing:stop",
      "progress:run-finalizing",
      "sendFinalResponse:final transcript",
      "info:completed run",
      "typing:stop",
      "terminateQuestionBatches:session-1:expired",
      "setActiveRun:null",
    ]);
  });

  test("warns when the progress worker already exited before finalization", async () => {
    const session = makeSession();
    const responseMessage = makeMessage("m-1");
    const initialRequests = makeInitialRequests(responseMessage);
    const { runtime, calls } = await makeRuntime({
      progressBehavior: "exit",
    });

    await Effect.runPromise(executeRunBatch(runtime)(session, initialRequests));

    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "typing:start",
      "setActiveRun:active",
      "runPrompts",
      "typing:stop",
      "progress:exit",
      "warn:progress worker exited before finalization",
      "sendFinalResponse:final transcript",
      "info:completed run",
      "typing:stop",
      "terminateQuestionBatches:session-1:expired",
      "setActiveRun:null",
    ]);
  });
});
