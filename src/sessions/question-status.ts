import { Effect, ServiceMap } from "effect";

export type QuestionStatusShape = {
  hasPendingQuestions: (sessionId: string) => Effect.Effect<boolean, unknown>;
};

export class QuestionStatus extends ServiceMap.Service<QuestionStatus, QuestionStatusShape>()(
  "QuestionStatus",
) {}

export const makeQuestionStatus = (
  hasPendingQuestions: QuestionStatusShape["hasPendingQuestions"],
): QuestionStatusShape => ({
  hasPendingQuestions,
});
