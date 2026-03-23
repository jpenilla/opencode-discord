import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2";
import type { Effect } from "effect";
import type { Interaction } from "discord.js";

export type QuestionWorkflowEvent =
  | { type: "asked"; sessionId: string; request: QuestionRequest }
  | {
      type: "replied";
      sessionId: string;
      requestId: string;
      answers: ReadonlyArray<QuestionAnswer>;
    }
  | { type: "rejected"; sessionId: string; requestId: string };

export type QuestionRunWorkflow = {
  handleEvent: (event: QuestionWorkflowEvent) => Effect.Effect<void, unknown>;
  routeInteraction: (interaction: Interaction) => Effect.Effect<void, unknown>;
  hasPendingQuestions: () => Effect.Effect<boolean, unknown>;
  terminate: () => Effect.Effect<void, unknown>;
  shutdown: () => Effect.Effect<void, unknown>;
};
