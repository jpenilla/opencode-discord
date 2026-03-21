import { describe, expect, test } from "bun:test";
import type { Message, SendableChannels } from "discord.js";
import { Deferred, Effect, Queue, Ref } from "effect";

import type { PromptResult } from "@/opencode/service.ts";
import type { AdmittedPromptContext } from "@/sessions/run/prompt-context.ts";
import { executeRunBatch } from "@/sessions/run/run-executor.ts";
import type { NonEmptyRunRequestBatch } from "@/sessions/run/run-batch.ts";
import type { ActiveRun, ChannelSession, RunProgressEvent } from "@/sessions/session.ts";
import { appendRef, runTestEffect } from "../../support/runtime.ts";
import { makeRunMessage, makeTestSession } from "../../support/session.ts";
import { unsafeStub } from "../../support/stub.ts";

const makeInitialRequests = (message: Message): NonEmptyRunRequestBatch => [
  {
    message,
    prompt: "hello",
    attachmentMessages: [message],
  },
];

const runExecutorEffect = runTestEffect;
const makeRef = <A>(value: A) => runTestEffect(Ref.make(value));
const get = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref));
const makeRunInput = (messageId = "m-1") => {
  const session = makeTestSession();
  const responseMessage = makeRunMessage(messageId);
  return { session, initialRequests: makeInitialRequests(responseMessage) };
};

const makeRuntime = async (options?: {
  promptResult?: PromptResult;
  promptFailure?: unknown;
  progressBehavior?: "ack" | "exit";
  configureActiveRun?: (activeRun: ActiveRun) => void;
}) => {
  const calls = await makeRef<string[]>([]);
  const finalResponseMessageIds = await makeRef<string[]>([]);
  const questionUiFailureMessageIds = await makeRef<string[]>([]);
  const runFailureMessageIds = await makeRef<string[]>([]);
  const record = (entry: string) => appendRef(calls, entry);

  return {
    calls,
    finalResponseMessageIds,
    questionUiFailureMessageIds,
    runFailureMessageIds,
    runtime: {
      runPrompts: ({
        activeRun,
        initialRequests,
        handlePromptCompleted,
      }: {
        activeRun: ActiveRun;
        initialRequests: NonEmptyRunRequestBatch;
        handlePromptCompleted: (
          promptContext: AdmittedPromptContext,
          result: PromptResult,
        ) => Effect.Effect<void, unknown>;
      }) =>
        Effect.gen(function* () {
          yield* record("runPrompts");
          options?.configureActiveRun?.(activeRun);
          if (options?.promptFailure) {
            return yield* Effect.fail(options.promptFailure);
          }
          const result = options?.promptResult ?? {
            messageId: "msg-1",
            transcript: "final transcript",
          };
          yield* handlePromptCompleted(
            activeRun.currentPromptContext ?? {
              kind: "initial",
              prompt: initialRequests[0]!.prompt,
              replyTargetMessage: initialRequests[0]!.message,
              requestMessages: [initialRequests[0]!.message],
            },
            result,
          );
          return result;
        }),
      runProgressWorker: (
        _channel: SendableChannels,
        _session: Pick<ChannelSession, "channelSettings" | "opencode" | "workdir">,
        _message: Message,
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
                  Effect.andThen(Deferred.succeed(event.ack, undefined).pipe(Effect.ignore)),
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
        }).pipe(Effect.andThen(record(`setActiveRun:${activeRun ? "active" : "null"}`))),
      terminateQuestionBatches: (sessionId: string) =>
        record(`terminateQuestionBatches:${sessionId}:expired`),
      ensureSessionHealthAfterFailure: (_session: ChannelSession, _responseMessage: Message) =>
        record("ensureSessionHealthAfterFailure"),
      sendRunInterruptedInfo: (_message: Message, source: "user" | "shutdown") =>
        record(`sendRunInterruptedInfo:${source}`),
      sendFinalResponse: (message: Message, text: string) =>
        appendRef(finalResponseMessageIds, message.id).pipe(
          Effect.andThen(record(`sendFinalResponse:${text}`)),
        ),
      sendRunFailure: (message: Message, error: unknown) =>
        appendRef(runFailureMessageIds, message.id).pipe(
          Effect.andThen(
            record(`sendRunFailure:${error instanceof Error ? error.message : String(error)}`),
          ),
        ),
      sendQuestionUiFailure: (message: Message, error: unknown) =>
        appendRef(questionUiFailureMessageIds, message.id).pipe(
          Effect.andThen(record(`sendQuestionUiFailure:${String(error)}`)),
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
    const { session, initialRequests } = makeRunInput();
    const { runtime, calls } = await makeRuntime();

    await runExecutorEffect(executeRunBatch(runtime)(session, initialRequests));

    expect(await get(calls)).toEqual([
      "typing:start",
      "setActiveRun:active",
      "runPrompts",
      "sendFinalResponse:final transcript",
      "typing:stop",
      "progress:run-finalizing",
      "info:completed run",
      "typing:stop",
      "terminateQuestionBatches:session-1:expired",
      "setActiveRun:null",
    ]);
    expect(session.activeRun).toBeNull();
  });

  test("sends the final Discord reply against the current prompt reply target", async () => {
    const { session } = makeRunInput();
    const originMessage = makeRunMessage("trigger-message");
    const replyTargetMessage = makeRunMessage("follow-up-message");
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

    await runExecutorEffect(executeRunBatch(runtime)(session, initialRequests));

    expect(await get(finalResponseMessageIds)).toEqual(["follow-up-message"]);
  });

  test("sends the question UI failure reply for empty transcripts with an unnotified UI failure", async () => {
    const { session, initialRequests } = makeRunInput();
    const replyTargetMessage = makeRunMessage("question-target");
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

    await runExecutorEffect(executeRunBatch(runtime)(session, initialRequests));

    const seen = await get(calls);
    expect(seen).toContain("sendQuestionUiFailure:question failed");
    expect(seen.some((entry) => entry.startsWith("sendFinalResponse:"))).toBe(false);
    expect(await get(questionUiFailureMessageIds)).toEqual(["question-target"]);
  });

  test("sends a run failure and triggers health recovery after non-interrupt errors", async () => {
    const { session, initialRequests } = makeRunInput();
    const replyTargetMessage = makeRunMessage("failure-target");
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

    await runExecutorEffect(executeRunBatch(runtime)(session, initialRequests));

    expect(await get(calls)).toEqual([
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
    expect(await get(runFailureMessageIds)).toEqual(["failure-target"]);
  });

  test("suppresses run failure and health recovery when the run was intentionally interrupted", async () => {
    const { session, initialRequests } = makeRunInput();
    const { runtime, calls } = await makeRuntime({
      promptFailure: new Error("interrupted"),
      configureActiveRun: (activeRun) => {
        activeRun.interruptRequested = true;
      },
    });

    await runExecutorEffect(executeRunBatch(runtime)(session, initialRequests));

    expect(await get(calls)).toEqual([
      "typing:start",
      "setActiveRun:active",
      "runPrompts",
      "info:interrupted run",
      "typing:stop",
      "progress:run-finalizing",
      "sendRunInterruptedInfo:user",
      "typing:stop",
      "terminateQuestionBatches:session-1:expired",
      "setActiveRun:null",
    ]);
  });

  test("clears a stale interrupt request when the run still completes successfully", async () => {
    const { session, initialRequests } = makeRunInput();
    const { runtime, calls } = await makeRuntime({
      configureActiveRun: (activeRun) => {
        activeRun.interruptRequested = true;
      },
    });

    await runExecutorEffect(executeRunBatch(runtime)(session, initialRequests));

    expect(await get(calls)).toEqual([
      "typing:start",
      "setActiveRun:active",
      "runPrompts",
      "sendFinalResponse:final transcript",
      "warn:interrupt request did not stop run",
      "typing:stop",
      "progress:run-finalizing",
      "info:completed run",
      "typing:stop",
      "terminateQuestionBatches:session-1:expired",
      "setActiveRun:null",
    ]);
  });

  test("warns when the progress worker already exited before finalization", async () => {
    const { session, initialRequests } = makeRunInput();
    const { runtime, calls } = await makeRuntime({
      progressBehavior: "exit",
    });

    await runExecutorEffect(executeRunBatch(runtime)(session, initialRequests));

    expect(await get(calls)).toEqual([
      "progress:exit",
      "typing:start",
      "setActiveRun:active",
      "runPrompts",
      "sendFinalResponse:final transcript",
      "typing:stop",
      "warn:progress worker exited before finalization",
      "info:completed run",
      "typing:stop",
      "terminateQuestionBatches:session-1:expired",
      "setActiveRun:null",
    ]);
  });

  test("sends a Discord reply for each completed prompt round in the same run", async () => {
    const session = makeTestSession();
    const originMessage = makeRunMessage("trigger-message");
    const followUpMessage = makeRunMessage("follow-up-message");
    const initialRequests = makeInitialRequests(originMessage);
    const calls = await makeRef<string[]>([]);
    const finalResponseMessageIds = await makeRef<string[]>([]);
    const record = (entry: string) => appendRef(calls, entry);

    const runtime = {
      ...(await makeRuntime()).runtime,
      runPrompts: ({
        handlePromptCompleted,
      }: {
        handlePromptCompleted: (
          promptContext: AdmittedPromptContext,
          result: PromptResult,
        ) => Effect.Effect<void, unknown>;
      }) =>
        Effect.gen(function* () {
          yield* record("runPrompts");
          yield* handlePromptCompleted(
            {
              kind: "initial",
              prompt: "initial",
              replyTargetMessage: originMessage,
              requestMessages: [originMessage],
            },
            { messageId: "msg-1", transcript: "first reply" },
          );
          yield* handlePromptCompleted(
            {
              kind: "follow-up",
              prompt: "follow-up",
              replyTargetMessage: followUpMessage,
              requestMessages: [followUpMessage],
            },
            { messageId: "msg-2", transcript: "second reply" },
          );
          return { messageId: "msg-2", transcript: "second reply" };
        }),
      sendFinalResponse: (message: Message, text: string) =>
        appendRef(finalResponseMessageIds, message.id).pipe(
          Effect.andThen(record(`sendFinalResponse:${text}`)),
        ),
    } as const;

    await runExecutorEffect(executeRunBatch(runtime)(session, initialRequests));

    expect(await get(finalResponseMessageIds)).toEqual(["trigger-message", "follow-up-message"]);
  });

  test("sends replies in order across multiple chained follow-up rounds", async () => {
    const session = makeTestSession();
    const originMessage = makeRunMessage("trigger-message");
    const followUpMessageOne = makeRunMessage("follow-up-message-1");
    const followUpMessageTwo = makeRunMessage("follow-up-message-2");
    const initialRequests = makeInitialRequests(originMessage);
    const finalResponseMessageIds = await makeRef<string[]>([]);

    const runtime = {
      ...(await makeRuntime()).runtime,
      runPrompts: ({
        handlePromptCompleted,
      }: {
        handlePromptCompleted: (
          promptContext: AdmittedPromptContext,
          result: PromptResult,
        ) => Effect.Effect<void, unknown>;
      }) =>
        Effect.gen(function* () {
          yield* handlePromptCompleted(
            {
              kind: "initial",
              prompt: "initial",
              replyTargetMessage: originMessage,
              requestMessages: [originMessage],
            },
            { messageId: "msg-1", transcript: "first reply" },
          );
          yield* handlePromptCompleted(
            {
              kind: "follow-up",
              prompt: "follow-up-1",
              replyTargetMessage: followUpMessageOne,
              requestMessages: [followUpMessageOne],
            },
            { messageId: "msg-2", transcript: "second reply" },
          );
          yield* handlePromptCompleted(
            {
              kind: "follow-up",
              prompt: "follow-up-2",
              replyTargetMessage: followUpMessageTwo,
              requestMessages: [followUpMessageTwo],
            },
            { messageId: "msg-3", transcript: "third reply" },
          );
          return { messageId: "msg-3", transcript: "third reply" };
        }),
      sendFinalResponse: (message: Message, text: string) =>
        appendRef(finalResponseMessageIds, `${message.id}:${text}`),
    } as const;

    await runExecutorEffect(executeRunBatch(runtime)(session, initialRequests));

    expect(await get(finalResponseMessageIds)).toEqual([
      "trigger-message:first reply",
      "follow-up-message-1:second reply",
      "follow-up-message-2:third reply",
    ]);
  });
});
