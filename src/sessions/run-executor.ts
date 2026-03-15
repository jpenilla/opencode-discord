import type { Message } from "discord.js";
import { Deferred, Effect, Fiber, Queue, Ref } from "effect";

import { decideRunCompletion } from "@/sessions/command-lifecycle.ts";
import type { PromptResult, SessionHandle } from "@/opencode/service.ts";
import type { PendingPrompt } from "@/sessions/prompt-state.ts";
import type { AdmittedPromptContext } from "@/sessions/prompt-context.ts";
import type { NonEmptyRunRequestBatch } from "@/sessions/run-batch.ts";
import {
  currentPromptReplyTargetMessage,
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
  handlePromptCompleted: (
    promptContext: AdmittedPromptContext,
    result: PromptResult,
  ) => Effect.Effect<void, unknown>;
};

type RunExecutorRuntime = {
  runPrompts: (input: RunExecutorPromptInput) => Effect.Effect<PromptResult, unknown>;
  runProgressWorker: (
    session: ChannelSession,
    message: Message,
    workdir: string,
    queue: Queue.Queue<RunProgressEvent>,
  ) => Effect.Effect<unknown, unknown>;
  startTyping: (message: Message) => TypingLoop;
  setActiveRun: (
    session: ChannelSession,
    activeRun: ActiveRun | null,
  ) => Effect.Effect<void, unknown>;
  terminateQuestionBatches: (sessionId: string) => Effect.Effect<void, unknown>;
  ensureSessionHealthAfterFailure: (
    session: ChannelSession,
    responseMessage: Message,
  ) => Effect.Effect<void, unknown>;
  sendRunInterruptedInfo: (message: Message) => Effect.Effect<void, unknown>;
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
      const originMessage = initialRequests[0]!.message;
      const progressFiber = yield* runtime
        .runProgressWorker(session, originMessage, session.workdir, progressQueue)
        .pipe(Effect.fork);
      const finalizeProgress = (reason?: RunFinalizationReason) =>
        finishProgressWorker(runtime, session, progressQueue, progressFiber, reason);
      const activeRun: ActiveRun = {
        originMessage,
        workdir: session.workdir,
        attachmentMessagesById: new Map<string, Message>(),
        currentPromptContext: null,
        previousPromptMessageIds: new Set<string>(),
        currentPromptMessageIds: new Set<string>(),
        currentPromptUserMessageId: null,
        assistantMessageParentIds: new Map<string, string>(),
        observedToolCallIds: new Set<string>(),
        progressQueue,
        promptState,
        followUpQueue,
        acceptFollowUps,
        typing: runtime.startTyping(originMessage),
        finalizeProgress,
        questionOutcome: noQuestionOutcome(),
        interruptRequested: false,
      };
      yield* runtime.setActiveRun(session, activeRun);

      const stopTyping = Effect.promise(() => activeRun.typing.stop());
      let failed = false;
      const handlePromptCompleted = (promptContext: AdmittedPromptContext, result: PromptResult) =>
        Effect.gen(function* () {
          const completion = decideRunCompletion({
            transcript: result.transcript,
            questionOutcome: activeRun.questionOutcome,
            interruptRequested: activeRun.interruptRequested,
          });

          switch (completion.type) {
            case "send-final-response":
              yield* runtime.sendFinalResponse(promptContext.replyTargetMessage, result.transcript);
              break;
            case "send-question-ui-failure":
              yield* runtime.sendQuestionUiFailure(
                promptContext.replyTargetMessage,
                completion.message,
              );
              break;
            case "suppress-response":
              break;
          }

          activeRun.questionOutcome = noQuestionOutcome();
        });

      const runResult = yield* Effect.gen(function* () {
        const result = yield* runtime.runPrompts({
          channelId: session.channelId,
          session: session.opencode,
          activeRun,
          initialRequests,
          handlePromptCompleted,
        });

        if (activeRun.interruptRequested) {
          activeRun.interruptRequested = false;
          yield* runtime.logger.warn("interrupt request did not stop run", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
          });
        }

        yield* stopTyping;
        yield* finalizeProgress();
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
          yield* runtime.sendRunInterruptedInfo(originMessage);
        } else {
          yield* runtime.logger.error("run failed", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: runtime.formatError(error),
          });
          yield* stopTyping;
          yield* runtime.sendRunFailure(currentPromptReplyTargetMessage(activeRun), error);
          failed = true;
        }
      }

      yield* stopTyping;
      yield* runtime.terminateQuestionBatches(session.opencode.sessionId);
      yield* runtime.setActiveRun(session, null);
      yield* Fiber.interrupt(progressFiber);

      if (failed) {
        yield* runtime.ensureSessionHealthAfterFailure(session, originMessage).pipe(Effect.ignore);
      }
    });
