import { Effect, Option } from "effect";

import {
  clearRunInterrupt,
  readRunInterrupt,
  readRunQuestionOutcome,
  setRunQuestionOutcome,
} from "@/sessions/run/active-state.ts";
import { isQuestionOutcomeNone, type ActiveRun, type QuestionOutcome } from "@/sessions/types.ts";
import type { LoggerShape } from "@/util/logging.ts";

export type QuestionWorkflowSignal =
  | { type: "clear-run-interrupt" }
  | { type: "set-run-question-outcome"; outcome: QuestionOutcome };

export type QuestionTypingAction = "none" | "pause" | "resume" | "stop";

export const applyQuestionSignals = (
  activeRun: ActiveRun | null,
  signals: ReadonlyArray<QuestionWorkflowSignal>,
) =>
  !activeRun
    ? Effect.void
    : Effect.forEach(
        signals,
        (item) =>
          Effect.sync(() => {
            switch (item.type) {
              case "clear-run-interrupt":
                clearRunInterrupt(activeRun);
                break;
              case "set-run-question-outcome":
                setRunQuestionOutcome(activeRun, item.outcome);
                break;
            }
          }),
        { discard: true },
      );

export const questionTypingAction = (activeRun: ActiveRun, pending: boolean, paused: boolean) => {
  if (pending) {
    return paused ? "none" : "pause";
  }
  if (
    !isQuestionOutcomeNone(readRunQuestionOutcome(activeRun)) ||
    readRunInterrupt(activeRun).requested
  ) {
    return "stop";
  }
  return paused ? "resume" : "none";
};

export const runQuestionTypingAction = (input: {
  sessionId: string;
  activeRun: ActiveRun;
  action: QuestionTypingAction;
  logger: Pick<LoggerShape, "warn">;
}) => {
  switch (input.action) {
    case "none":
      return Effect.void;
    case "resume":
      return Effect.sync(() => {
        input.activeRun.typing.resume();
      });
    case "stop":
      return Effect.promise(() => input.activeRun.typing.stop()).pipe(Effect.ignore);
    case "pause":
      return Effect.promise(() => input.activeRun.typing.pause()).pipe(
        Effect.timeoutOption("1 second"),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.void
            : input.logger.warn("typing pause timed out while question prompt was active", {
                channelId: input.activeRun.originMessage.channelId,
                sessionId: input.sessionId,
              }),
        ),
      );
  }
};
