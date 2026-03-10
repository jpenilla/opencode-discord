import type { Message } from "discord.js";
import { Deferred, Effect, Fiber, Queue, Ref } from "effect";

import { decideRunCompletion } from "@/sessions/command-lifecycle.ts";
import type { PromptResult, SessionHandle } from "@/opencode/service.ts";
import type { PendingPrompt } from "@/sessions/prompt-state.ts";
import type { NonEmptyRunRequestBatch } from "@/sessions/run-batch.ts";
import {
  noQuestionOutcome,
  type ActiveRun,
  type ChannelSession,
  type RunFinalizationReason,
  type RunProgressEvent,
  type RunRequest,
} from "@/sessions/session.ts";
import type { TypingLoop } from "@/discord/messages.ts";
import type { LoggerShape } from "@/util/logging.ts";

type RunExecutorPromptInput = {
  channelId: string;
  session: SessionHandle;
  activeRun: ActiveRun;
  initialRequests: NonEmptyRunRequestBatch;
};

type RunExecutorRuntime = {
  runPrompts: (input: RunExecutorPromptInput) => Effect.Effect<PromptResult, unknown>;
  runProgressWorker: (
    message: Message,
    workdir: string,
    queue: Queue.Queue<RunProgressEvent>,
  ) => Effect.Effect<unknown, unknown>;
  startTyping: (message: Message) => TypingLoop;
  setActiveRun: (
    session: ChannelSession,
    activeRun: ActiveRun | null,
  ) => Effect.Effect<void, unknown>;
  terminateQuestionBatches: (
    sessionId: string,
    reason: Extract<RunFinalizationReason, "interrupted"> | "expired",
  ) => Effect.Effect<void, unknown>;
  ensureSessionHealthAfterFailure: (
    session: ChannelSession,
    responseMessage: Message,
  ) => Effect.Effect<void, unknown>;
  sendFinalResponse: (message: Message, text: string) => Effect.Effect<void, unknown>;
  sendRunFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>;
  sendQuestionUiFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>;
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

const finishProgressWorker = (
  runtime: Pick<RunExecutorRuntime, "logger">,
  session: ChannelSession,
  progressQueue: Queue.Queue<RunProgressEvent>,
  progressFiber: Fiber.Fiber<unknown, unknown>,
  reason?: RunFinalizationReason,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const progressFiberExit = yield* Fiber.poll(progressFiber);
    if (progressFiberExit._tag === "None") {
      const finalizingAck = yield* Deferred.make<void>();
      yield* Queue.offer(progressQueue, { type: "run-finalizing", ack: finalizingAck, reason });
      const finalizingResult = yield* Deferred.await(finalizingAck).pipe(
        Effect.timeoutOption("2 seconds"),
      );
      if (finalizingResult._tag === "None") {
        yield* runtime.logger.warn("progress worker finalization timed out", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
        });
      }
      return;
    }

    yield* runtime.logger.warn("progress worker exited before finalization", {
      channelId: session.channelId,
      sessionId: session.opencode.sessionId,
      exit: String(progressFiberExit.value),
    });
  });

export const executeRunBatch =
  (runtime: RunExecutorRuntime) =>
  (
    session: ChannelSession,
    initialRequests: NonEmptyRunRequestBatch,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const progressQueue = yield* Queue.unbounded<RunProgressEvent>();
      const promptState = yield* Ref.make<PendingPrompt | null>(null);
      const followUpQueue = yield* Queue.unbounded<RunRequest>();
      const acceptFollowUps = yield* Ref.make(true);
      const responseMessage = initialRequests[0]!.message;
      const progressFiber = yield* runtime
        .runProgressWorker(responseMessage, session.workdir, progressQueue)
        .pipe(Effect.fork);
      const finalizeProgress = (reason?: RunFinalizationReason) =>
        finishProgressWorker(runtime, session, progressQueue, progressFiber, reason);
      const activeRun: ActiveRun = {
        discordMessage: responseMessage,
        workdir: session.workdir,
        attachmentMessagesById: new Map<string, Message>(),
        progressQueue,
        promptState,
        followUpQueue,
        acceptFollowUps,
        typing: runtime.startTyping(responseMessage),
        finalizeProgress,
        questionOutcome: noQuestionOutcome(),
        interruptRequested: false,
      };
      yield* runtime.setActiveRun(session, activeRun);

      const stopTyping = Effect.promise(() => activeRun.typing.stop());
      let failed = false;

      const runResult = yield* Effect.gen(function* () {
        const result = yield* runtime.runPrompts({
          channelId: session.channelId,
          session: session.opencode,
          activeRun,
          initialRequests,
        });

        const completion = decideRunCompletion({
          transcript: result.transcript,
          questionOutcome: activeRun.questionOutcome,
          interruptRequested: activeRun.interruptRequested,
        });

        yield* stopTyping;
        yield* finalizeProgress();
        switch (completion.type) {
          case "send-final-response":
            yield* runtime.sendFinalResponse(responseMessage, result.transcript);
            break;
          case "send-question-ui-failure":
            yield* runtime.sendQuestionUiFailure(responseMessage, completion.message);
            break;
          case "suppress-response":
            break;
        }
        yield* runtime.logger.info("completed run", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          opencodeMessageId: result.messageId,
        });
      }).pipe(Effect.either);

      if (runResult._tag === "Left") {
        const error = runResult.left;
        if (activeRun.interruptRequested) {
          yield* runtime.logger.info("interrupted run", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: runtime.formatError(error),
          });
          yield* stopTyping;
          yield* finalizeProgress("interrupted");
        } else {
          yield* runtime.logger.error("run failed", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: runtime.formatError(error),
          });
          yield* stopTyping;
          yield* runtime.sendRunFailure(responseMessage, error);
          failed = true;
        }
      }

      yield* stopTyping;
      yield* runtime.setActiveRun(session, null);
      yield* runtime.terminateQuestionBatches(
        session.opencode.sessionId,
        activeRun.interruptRequested ? "interrupted" : "expired",
      );
      yield* Fiber.interrupt(progressFiber);

      if (failed) {
        yield* runtime
          .ensureSessionHealthAfterFailure(session, responseMessage)
          .pipe(Effect.ignore);
      }
    });
