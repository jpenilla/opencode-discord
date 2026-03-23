import { Effect, ServiceMap } from "effect";
import type { Message } from "discord.js";

import { OpencodeService } from "@/opencode/service.ts";
import { makeQuestionRunWorkflow } from "@/sessions/question/question-run-workflow.ts";
import type { QuestionRunWorkflow } from "@/sessions/question/question-workflow-types.ts";
import type { ActiveRun, ChannelSession } from "@/sessions/session.ts";
import { Logger } from "@/util/logging.ts";

export type QuestionRuntimeShape = {
  createRunWorkflow: (
    session: ChannelSession,
    activeRun: ActiveRun,
  ) => Effect.Effect<QuestionRunWorkflow, unknown>;
};

export class QuestionRuntime extends ServiceMap.Service<QuestionRuntime, QuestionRuntimeShape>()(
  "QuestionRuntime",
) {}

export const makeQuestionRuntime = (
  sendQuestionUiFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>,
): Effect.Effect<QuestionRuntimeShape, unknown, OpencodeService | Logger> =>
  Effect.gen(function* () {
    const logger = yield* Logger;
    const opencode = yield* OpencodeService;

    return {
      createRunWorkflow: (session, activeRun) =>
        makeQuestionRunWorkflow({
          session,
          activeRun,
          sendQuestionUiFailure,
          logger,
          opencode,
        }),
    } satisfies QuestionRuntimeShape;
  });
