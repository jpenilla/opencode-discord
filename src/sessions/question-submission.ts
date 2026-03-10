import { Effect } from "effect";
import type { QuestionAnswer } from "@opencode-ai/sdk/v2";

import {
  setQuestionBatchStatus,
  type QuestionBatchState,
} from "@/sessions/question-batch-state.ts";
import { noQuestionOutcome, type QuestionOutcome } from "@/sessions/session.ts";

type QuestionSubmissionBatch<SessionHandle> = QuestionBatchState & {
  session: {
    opencode: SessionHandle;
    activeRun: { questionOutcome: QuestionOutcome } | null;
  };
};

type QuestionSubmissionRuntime<
  Batch extends QuestionSubmissionBatch<SessionHandle>,
  Interaction,
  SessionHandle,
> = {
  persistBatch: (
    requestId: string,
    update: (batch: Batch) => Batch | null,
  ) => Effect.Effect<Batch | null, unknown>;
  updateInteraction: (interaction: Interaction, batch: Batch) => Effect.Effect<void, unknown>;
  editBatch: (batch: Batch) => Effect.Effect<void, unknown>;
  finalizeBatch: (
    requestId: string,
    status: "answered" | "rejected",
    resolvedAnswers?: ReadonlyArray<QuestionAnswer>,
  ) => Effect.Effect<void, unknown>;
  replyExpired: (interaction: Interaction) => Effect.Effect<void, unknown>;
  followUpFailure: (interaction: Interaction, message: string) => Effect.Effect<void, unknown>;
  submitToOpencode: (
    session: SessionHandle,
    requestId: string,
    answers: Array<QuestionAnswer>,
  ) => Effect.Effect<void, unknown>;
  rejectInOpencode: (session: SessionHandle, requestId: string) => Effect.Effect<void, unknown>;
  formatError: (error: unknown) => string;
};

type SubmitQuestionInput<Interaction> = {
  interaction: Interaction;
  requestId: string;
  answers: Array<QuestionAnswer>;
};

type RejectQuestionInput<Interaction> = {
  interaction: Interaction;
  requestId: string;
};

export const submitQuestionBatch =
  <Batch extends QuestionSubmissionBatch<SessionHandle>, Interaction, SessionHandle>(
    runtime: QuestionSubmissionRuntime<Batch, Interaction, SessionHandle>,
  ) =>
  ({
    interaction,
    requestId,
    answers,
  }: SubmitQuestionInput<Interaction>): Effect.Effect<boolean, unknown> =>
    Effect.gen(function* () {
      const submitting = yield* runtime.persistBatch(requestId, (current) =>
        setQuestionBatchStatus(current, "submitting"),
      );
      if (!submitting) {
        yield* runtime.replyExpired(interaction);
        return true;
      }

      yield* runtime.updateInteraction(interaction, submitting);

      const submitResult = yield* runtime
        .submitToOpencode(submitting.session.opencode, submitting.request.id, answers)
        .pipe(Effect.either);
      if (submitResult._tag === "Left") {
        const restored = yield* runtime.persistBatch(requestId, (current) =>
          setQuestionBatchStatus(current, "active"),
        );
        if (restored) {
          yield* runtime.editBatch(restored).pipe(Effect.ignore);
        }
        yield* runtime
          .followUpFailure(
            interaction,
            `Failed to submit answers: ${runtime.formatError(submitResult.left)}`,
          )
          .pipe(Effect.ignore);
        return true;
      }

      yield* runtime.finalizeBatch(submitting.request.id, "answered", answers);
      return true;
    });

export const rejectQuestionBatch =
  <Batch extends QuestionSubmissionBatch<SessionHandle>, Interaction, SessionHandle>(
    runtime: QuestionSubmissionRuntime<Batch, Interaction, SessionHandle>,
  ) =>
  ({ interaction, requestId }: RejectQuestionInput<Interaction>): Effect.Effect<boolean, unknown> =>
    Effect.gen(function* () {
      const rejecting = yield* runtime.persistBatch(requestId, (current) =>
        setQuestionBatchStatus(current, "submitting"),
      );
      if (!rejecting) {
        yield* runtime.replyExpired(interaction);
        return true;
      }

      yield* runtime.updateInteraction(interaction, rejecting);

      if (rejecting.session.activeRun) {
        rejecting.session.activeRun.questionOutcome = { _tag: "user-rejected" };
      }

      const rejectResult = yield* runtime
        .rejectInOpencode(rejecting.session.opencode, rejecting.request.id)
        .pipe(Effect.either);
      if (rejectResult._tag === "Left") {
        if (rejecting.session.activeRun) {
          rejecting.session.activeRun.questionOutcome = noQuestionOutcome();
        }

        const restored = yield* runtime.persistBatch(requestId, (current) =>
          setQuestionBatchStatus(current, "active"),
        );
        if (restored) {
          yield* runtime.editBatch(restored).pipe(Effect.ignore);
        }
        yield* runtime
          .followUpFailure(
            interaction,
            `Failed to reject questions: ${runtime.formatError(rejectResult.left)}`,
          )
          .pipe(Effect.ignore);
        return true;
      }

      yield* runtime.finalizeBatch(rejecting.request.id, "rejected");
      return true;
    });
