import { describe, expect, test } from "bun:test";
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";
import { Effect, Ref } from "effect";

import { rejectQuestionBatch, submitQuestionBatch } from "@/sessions/question-submission.ts";
import type { QuestionBatchState } from "@/sessions/question-batch-state.ts";
import { noQuestionOutcome, type QuestionOutcome } from "@/sessions/session.ts";
import { unsafeStub } from "../support/stub.ts";

type TestInteraction = { id: string };
type TestSessionHandle = { id: string };
type TestBatch = QuestionBatchState & {
  session: {
    opencode: TestSessionHandle;
    activeRun: { questionOutcome: QuestionOutcome } | null;
  };
};

const makeRequest = (id = "req-1") =>
  unsafeStub<QuestionRequest>({
    id,
    questions: [{ question: "Question?", options: [{ label: "Yes", description: "desc" }] }],
  });

const makeBatch = (): TestBatch => ({
  request: makeRequest(),
  version: 0,
  page: 0,
  optionPages: [0],
  drafts: [{ selectedOptions: ["Yes"], customAnswer: null }],
  status: "active",
  session: {
    opencode: { id: "session-1" },
    activeRun: { questionOutcome: noQuestionOutcome() },
  },
});

const makeRuntime = async (options?: {
  batch?: TestBatch | null;
  submitResult?: "success" | "failure";
  rejectResult?: "success" | "failure";
}) => {
  const initialBatch = options && "batch" in options ? (options.batch ?? null) : makeBatch();
  const currentBatch = await Effect.runPromise(Ref.make<TestBatch | null>(initialBatch));
  const calls = await Effect.runPromise(Ref.make<string[]>([]));

  const record = (entry: string) => Ref.update(calls, (current) => [...current, entry]);

  return {
    currentBatch,
    calls,
    runtime: {
      tryPersistBatch: (
        requestId: string,
        expectedVersion: number,
        actorId: string,
        update: (batch: TestBatch) => TestBatch,
      ) =>
        Effect.gen(function* () {
          yield* record(`try-persist:${requestId}:${expectedVersion}:${actorId}`);
          return yield* Ref.modify(
            currentBatch,
            (
              batch,
            ): readonly [
              (
                | { type: "updated"; batch: TestBatch }
                | { type: "missing" }
                | { type: "conflict"; batch: TestBatch }
              ),
              TestBatch | null,
            ] => {
              if (!batch) {
                return [{ type: "missing" }, null];
              }
              if (batch.version !== expectedVersion) {
                return [{ type: "conflict", batch }, batch];
              }
              const nextBase = update(batch);
              const next = nextBase === batch ? batch : { ...nextBase, version: batch.version + 1 };
              return [{ type: "updated", batch: next }, next];
            },
          );
        }),
      restoreBatch: (requestId: string, update: (batch: TestBatch) => TestBatch | null) =>
        Effect.gen(function* () {
          yield* record(`restore:${requestId}`);
          return yield* Ref.modify(
            currentBatch,
            (batch): readonly [TestBatch | null, TestBatch | null] => {
              if (!batch) {
                return [null, null];
              }
              const next = update(batch);
              return [next, next];
            },
          );
        }),
      updateInteraction: (_interaction: TestInteraction, batch: TestBatch) =>
        record(`update:${batch.status}`),
      editBatch: (batch: TestBatch) => record(`edit:${batch.status}`),
      finalizeBatch: (
        requestId: string,
        status: "answered" | "rejected",
        resolvedAnswers?: ReadonlyArray<QuestionAnswer>,
      ) =>
        record(
          resolvedAnswers
            ? `finalize:${requestId}:${status}:${JSON.stringify(resolvedAnswers)}`
            : `finalize:${requestId}:${status}`,
        ),
      replyExpired: () => record("reply-expired"),
      replyConflict: (_interaction: TestInteraction, batch: TestBatch) =>
        record(`reply-conflict:${batch.version}`),
      followUpFailure: (_interaction: TestInteraction, message: string) =>
        record(`follow-up:${message}`),
      submitToOpencode: (
        _session: TestSessionHandle,
        requestId: string,
        answers: ReadonlyArray<QuestionAnswer>,
      ) =>
        options?.submitResult === "failure"
          ? record(`submit:${requestId}:${JSON.stringify(answers)}`).pipe(
              Effect.andThen(Effect.fail(new Error("submit failed"))),
            )
          : record(`submit:${requestId}:${JSON.stringify(answers)}`),
      rejectInOpencode: (_session: TestSessionHandle, requestId: string) =>
        options?.rejectResult === "failure"
          ? record(`reject:${requestId}`).pipe(
              Effect.andThen(Effect.fail(new Error("reject failed"))),
            )
          : record(`reject:${requestId}`),
      formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    } as const,
  };
};

describe("submitQuestionBatch", () => {
  test("replies that the prompt expired when the batch is gone", async () => {
    const { runtime, calls } = await makeRuntime({ batch: null });

    const handled = await Effect.runPromise(
      submitQuestionBatch(runtime)({
        interaction: { id: "interaction-1" },
        requestId: "req-1",
        expectedVersion: 0,
        actorId: "owner",
        answers: [["Yes"]],
      }),
    );

    expect(handled).toBe(true);
    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "try-persist:req-1:0:owner",
      "reply-expired",
    ]);
  });

  test("updates the question card, submits answers, and finalizes on success", async () => {
    const { runtime, calls } = await makeRuntime();

    const handled = await Effect.runPromise(
      submitQuestionBatch(runtime)({
        interaction: { id: "interaction-1" },
        requestId: "req-1",
        expectedVersion: 0,
        actorId: "owner",
        answers: [["Yes"]],
      }),
    );

    expect(handled).toBe(true);
    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "try-persist:req-1:0:owner",
      "update:submitting",
      'submit:req-1:[["Yes"]]',
      'finalize:req-1:answered:[["Yes"]]',
    ]);
  });

  test("restores the batch to active and follows up on submit failure", async () => {
    const { runtime, calls, currentBatch } = await makeRuntime({ submitResult: "failure" });

    const handled = await Effect.runPromise(
      submitQuestionBatch(runtime)({
        interaction: { id: "interaction-1" },
        requestId: "req-1",
        expectedVersion: 0,
        actorId: "owner",
        answers: [["Yes"]],
      }),
    );

    expect(handled).toBe(true);
    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "try-persist:req-1:0:owner",
      "update:submitting",
      'submit:req-1:[["Yes"]]',
      "restore:req-1",
      "edit:active",
      "follow-up:Failed to submit answers: submit failed",
    ]);
    expect((await Effect.runPromise(Ref.get(currentBatch)))?.status).toBe("active");
  });

  test("replies with a conflict when another action already updated the batch", async () => {
    const { runtime, calls, currentBatch } = await makeRuntime();

    const handled = await Effect.runPromise(
      submitQuestionBatch(runtime)({
        interaction: { id: "interaction-1" },
        requestId: "req-1",
        expectedVersion: 1,
        actorId: "intruder",
        answers: [["Yes"]],
      }),
    );

    expect(handled).toBe(true);
    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "try-persist:req-1:1:intruder",
      "reply-conflict:0",
    ]);
    expect((await Effect.runPromise(Ref.get(currentBatch)))?.status).toBe("active");
  });
});

describe("rejectQuestionBatch", () => {
  test("marks the active run as user-rejected and finalizes on success", async () => {
    const { runtime, calls, currentBatch } = await makeRuntime();

    const handled = await Effect.runPromise(
      rejectQuestionBatch(runtime)({
        interaction: { id: "interaction-1" },
        requestId: "req-1",
        expectedVersion: 0,
        actorId: "owner",
      }),
    );

    expect(handled).toBe(true);
    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "try-persist:req-1:0:owner",
      "update:submitting",
      "reject:req-1",
      "finalize:req-1:rejected",
    ]);
    expect(
      (await Effect.runPromise(Ref.get(currentBatch)))?.session.activeRun?.questionOutcome,
    ).toEqual({
      _tag: "user-rejected",
    });
  });

  test("rolls back question outcome and restores the batch on reject failure", async () => {
    const { runtime, calls, currentBatch } = await makeRuntime({ rejectResult: "failure" });

    const handled = await Effect.runPromise(
      rejectQuestionBatch(runtime)({
        interaction: { id: "interaction-1" },
        requestId: "req-1",
        expectedVersion: 0,
        actorId: "owner",
      }),
    );

    expect(handled).toBe(true);
    expect(await Effect.runPromise(Ref.get(calls))).toEqual([
      "try-persist:req-1:0:owner",
      "update:submitting",
      "reject:req-1",
      "restore:req-1",
      "edit:active",
      "follow-up:Failed to reject questions: reject failed",
    ]);
    expect((await Effect.runPromise(Ref.get(currentBatch)))?.status).toBe("active");
    expect(
      (await Effect.runPromise(Ref.get(currentBatch)))?.session.activeRun?.questionOutcome,
    ).toEqual({
      _tag: "none",
    });
  });
});
