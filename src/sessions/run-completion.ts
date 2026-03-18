import type { QuestionOutcome } from "@/sessions/session.ts";

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
  if (input.questionOutcome._tag === "ui-failure" && !input.questionOutcome.notified) {
    return {
      type: "send-question-ui-failure",
      message: input.questionOutcome.message,
    };
  }
  if (input.interruptRequested || input.questionOutcome._tag === "user-rejected") {
    return { type: "suppress-response" };
  }
  return { type: "send-final-response" };
};
