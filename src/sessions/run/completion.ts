import {
  isQuestionOutcomeUiFailure,
  isQuestionOutcomeUserRejected,
  type QuestionOutcome,
} from "@/sessions/types.ts";

export const decideRunCompletion = (input: {
  transcript: string;
  questionOutcome: QuestionOutcome;
  interruptRequested: boolean;
}):
  | { type: "send-final-response" }
  | { type: "send-question-ui-failure"; message: string }
  | { type: "suppress-response" } => {
  if (input.transcript.trim()) {
    return { type: "send-final-response" };
  }
  if (isQuestionOutcomeUiFailure(input.questionOutcome) && !input.questionOutcome.notified) {
    return {
      type: "send-question-ui-failure",
      message: input.questionOutcome.message,
    };
  }
  if (input.interruptRequested || isQuestionOutcomeUserRejected(input.questionOutcome)) {
    return { type: "suppress-response" };
  }
  return { type: "send-final-response" };
};
