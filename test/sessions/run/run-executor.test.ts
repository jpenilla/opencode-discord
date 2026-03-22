import { describe, expect, test } from "bun:test";
import type { Message, SendableChannels } from "discord.js";
import { Deferred, Effect, Queue, Ref } from "effect";

import type { PromptResult } from "@/opencode/service.ts";
import type { AdmittedPromptContext } from "@/sessions/run/prompt-context.ts";
import { executeRunBatch } from "@/sessions/run/run-executor.ts";
import type { NonEmptyRunRequestBatch } from "@/sessions/run/run-batch.ts";
import type { ActiveRun, ChannelSession, RunProgressEvent } from "@/sessions/session.ts";
import { appendRef, makeRef, readRef, runTestEffect } from "../../support/runtime.ts";
import { makeRunMessage, makeTestSession } from "../../support/session.ts";

type PromptCompletion = { promptContext: AdmittedPromptContext; result: PromptResult };
type Runtime = Awaited<ReturnType<typeof makeRuntime>>["runtime"];
type RunPromptsInput = Parameters<Parameters<typeof executeRunBatch>[0]>[0];
type RuntimeOptions = {
  promptResult?: PromptResult;
  promptFailure?: unknown;
  progressBehavior?: "ack" | "exit";
  promptCompletions?: PromptCompletion[];
  configureActiveRun?: (activeRun: ActiveRun) => void;
};

const makeInitialRequests = (message: Message): NonEmptyRunRequestBatch => [
  { message, prompt: "hello", attachmentMessages: [message] },
];
const runBatch = (
  runtime: Runtime,
  session: ChannelSession,
  initialRequests: NonEmptyRunRequestBatch,
) =>
  runTestEffect(
    executeRunBatch(
      runtime.runPrompts,
      runtime.runProgressWorker,
      runtime.startTyping,
      runtime.setActiveRun,
      runtime.terminateQuestions,
      runtime.recoverSession,
      runtime.sendInterrupted,
      runtime.sendFinalResponse,
      runtime.sendRunFailure,
      runtime.sendUiFailure,
      runtime.logger,
    )(session, initialRequests),
  );
const makeRunBatchInput = (message: Message) => ({
  session: makeTestSession(),
  initialRequests: makeInitialRequests(message),
});
const makePromptContext = (
  kind: AdmittedPromptContext["kind"],
  replyTargetMessage: Message,
): AdmittedPromptContext => ({
  kind,
  prompt: kind,
  replyTargetMessage,
  requestMessages: [replyTargetMessage],
});
const setReplyTarget = (replyTargetMessage: Message) => (activeRun: ActiveRun) =>
  (activeRun.currentPromptContext = makePromptContext("follow-up", replyTargetMessage));
const requestInterrupt = (activeRun: ActiveRun) => (activeRun.interruptRequested = true);
const expectCalls = (calls: Ref.Ref<string[]>, expected: string[]) =>
  readRef(calls).then((seen) => expect(seen).toEqual(expected));
const runWith = async (
  options?: Parameters<typeof makeRuntime>[0],
  input = makeRunBatchInput(makeRunMessage("m-1")),
) =>
  makeRuntime(options).then(
    async (runtimeState) => (
      await runBatch(runtimeState.runtime, input.session, input.initialRequests),
      { ...input, ...runtimeState }
    ),
  );
const makePromptCompletion = (
  kind: AdmittedPromptContext["kind"],
  replyTargetMessage: Message,
  transcript: string,
  messageId: string,
) => ({
  promptContext: makePromptContext(kind, replyTargetMessage),
  result: { messageId, transcript } satisfies PromptResult,
});
const makeResponseRecordingRuntime = async (
  promptCompletions: PromptCompletion[],
  record: (message: Message, text: string) => string,
) => {
  const finalResponseMessageIds = await makeRef<string[]>([]);
  return {
    finalResponseMessageIds,
    runtime: {
      ...(await makeRuntime({ promptCompletions })).runtime,
      sendFinalResponse: (message: Message, text: string) =>
        appendRef(finalResponseMessageIds, record(message, text)),
    } as const,
  };
};

const makeRuntime = async (options?: RuntimeOptions) => {
  const calls = await makeRef<string[]>([]);
  const finalResponseMessageIds = await makeRef<string[]>([]);
  const uiFailureIds = await makeRef<string[]>([]);
  const runFailureIds = await makeRef<string[]>([]);
  const record = (entry: string) => appendRef(calls, entry);

  return {
    calls,
    finalResponseMessageIds,
    uiFailureIds,
    runFailureIds,
    runtime: {
      runPrompts: ({ activeRun, initialRequests, handlePromptCompleted }: RunPromptsInput) =>
        Effect.gen(function* () {
          yield* record("runPrompts");
          options?.configureActiveRun?.(activeRun);
          if (options?.promptFailure) {
            return yield* Effect.fail(options.promptFailure);
          }
          if (options?.promptCompletions) {
            for (const completion of options.promptCompletions) {
              yield* handlePromptCompleted(completion.promptContext, completion.result);
            }
            return options.promptCompletions.at(-1)!.result;
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
          stop: async () => void Effect.runSync(record("typing:stop")),
        };
      },
      setActiveRun: (session: ChannelSession, activeRun: ActiveRun | null) =>
        Effect.sync(() => {
          session.activeRun = activeRun;
        }).pipe(Effect.andThen(record(`setActiveRun:${activeRun ? "active" : "null"}`))),
      terminateQuestions: (sessionId: string) =>
        record(`terminateQuestionBatches:${sessionId}:expired`),
      recoverSession: (_session: ChannelSession, _responseMessage: Message) =>
        record("ensureSessionHealthAfterFailure"),
      sendInterrupted: (_message: Message, source: "user" | "shutdown") =>
        record(`sendRunInterruptedInfo:${source}`),
      sendFinalResponse: (message: Message, text: string) =>
        appendRef(finalResponseMessageIds, message.id).pipe(
          Effect.andThen(record(`sendFinalResponse:${text}`)),
        ),
      sendRunFailure: (message: Message, error: unknown) =>
        appendRef(runFailureIds, message.id).pipe(
          Effect.andThen(
            record(`sendRunFailure:${error instanceof Error ? error.message : String(error)}`),
          ),
        ),
      sendUiFailure: (message: Message, error: unknown) =>
        appendRef(uiFailureIds, message.id).pipe(
          Effect.andThen(record(`sendQuestionUiFailure:${String(error)}`)),
        ),
      logger: {
        info: (message: string) => record(`info:${message}`),
        warn: (message: string) => record(`warn:${message}`),
        error: (message: string) => record(`error:${message}`),
      },
    } as const,
  };
};

describe("executeRunBatch", () => {
  test("runs a successful batch through progress finalization and final reply", async () => {
    const { session, calls } = await runWith();

    await expectCalls(calls, [
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
    const originMessage = makeRunMessage("trigger-message");
    const replyTargetMessage = makeRunMessage("follow-up-message");
    const input = makeRunBatchInput(originMessage);
    const { finalResponseMessageIds } = await runWith(
      {
        promptResult: {
          messageId: "assistant-after-auto-compaction",
          transcript: "final transcript",
        },
        configureActiveRun: setReplyTarget(replyTargetMessage),
      },
      input,
    );

    expect(await readRef(finalResponseMessageIds)).toEqual(["follow-up-message"]);
  });

  test("sends the question UI failure reply for empty transcripts with an unnotified UI failure", async () => {
    const replyTargetMessage = makeRunMessage("question-target");
    const { calls, uiFailureIds } = await runWith({
      promptResult: { messageId: "msg-1", transcript: "" },
      configureActiveRun: (activeRun) => {
        setReplyTarget(replyTargetMessage)(activeRun);
        activeRun.questionOutcome = {
          _tag: "ui-failure",
          message: "question failed",
          notified: false,
        };
      },
    });

    const seen = await readRef(calls);
    expect(seen).toContain("sendQuestionUiFailure:question failed");
    expect(seen.some((entry) => entry.startsWith("sendFinalResponse:"))).toBe(false);
    expect(await readRef(uiFailureIds)).toEqual(["question-target"]);
  });

  test("sends a run failure and triggers health recovery after non-interrupt errors", async () => {
    const replyTargetMessage = makeRunMessage("failure-target");
    const { calls, runFailureIds } = await runWith({
      promptFailure: new Error("boom"),
      configureActiveRun: setReplyTarget(replyTargetMessage),
    });

    await expectCalls(calls, [
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
    expect(await readRef(runFailureIds)).toEqual(["failure-target"]);
  });

  test("suppresses run failure and health recovery when the run was intentionally interrupted", async () => {
    const { calls } = await runWith({
      promptFailure: new Error("interrupted"),
      configureActiveRun: requestInterrupt,
    });

    await expectCalls(calls, [
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
    const { calls } = await runWith({
      configureActiveRun: requestInterrupt,
    });

    await expectCalls(calls, [
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

  test("sends replies in order across multiple chained follow-up rounds", async () => {
    const originMessage = makeRunMessage("trigger-message");
    const followUpMessageOne = makeRunMessage("follow-up-message-1");
    const followUpMessageTwo = makeRunMessage("follow-up-message-2");
    const { session, initialRequests } = makeRunBatchInput(originMessage);
    const { finalResponseMessageIds, runtime } = await makeResponseRecordingRuntime(
      [
        makePromptCompletion("initial", originMessage, "first reply", "msg-1"),
        makePromptCompletion("follow-up", followUpMessageOne, "second reply", "msg-2"),
        makePromptCompletion("follow-up", followUpMessageTwo, "third reply", "msg-3"),
      ],
      (message, text) => `${message.id}:${text}`,
    );

    await runBatch(runtime, session, initialRequests);

    expect(await readRef(finalResponseMessageIds)).toEqual([
      "trigger-message:first reply",
      "follow-up-message-1:second reply",
      "follow-up-message-2:third reply",
    ]);
  });
});
