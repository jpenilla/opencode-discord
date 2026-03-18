import type { Message } from "discord.js";
import { Deferred, Effect, Fiber, Queue, Ref } from "effect";

import type { PromptResult, SessionHandle } from "@/opencode/service.ts";
import type { PendingPrompt } from "@/sessions/prompt-state.ts";
import type { AdmittedPromptContext } from "@/sessions/prompt-context.ts";
import type { NonEmptyRunRequestBatch } from "@/sessions/run-batch.ts";
import { decideRunCompletion } from "@/sessions/run-completion.ts";
import {
  currentPromptReplyTargetMessage,
  noQuestionOutcome,
  type ActiveRun,
  type ChannelSession,
  type RunInterruptSource,
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

type RunExecutorDeps = {
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
  sendRunInterruptedInfo: (
    message: Message,
    source: RunInterruptSource,
  ) => Effect.Effect<void, unknown>;
  sendFinalResponse: (message: Message, text: string) => Effect.Effect<void, unknown>;
  sendRunFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>;
  sendQuestionUiFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>;
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

const finishProgressWorker = (
  deps: Pick<RunExecutorDeps, "logger">,
  session: ChannelSession,
  progressQueue: Queue.Queue<RunProgressEvent>,
  progressFiber: Fiber.Fiber<unknown, unknown>,
  reason?: RunFinalizationReason,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const progressFiberExit = yield* Effect.sync(() => progressFiber.pollUnsafe());
    if (progressFiberExit === undefined) {
      const finalizingAck = yield* Deferred.make<void>();
      yield* Queue.offer(progressQueue, { type: "run-finalizing", ack: finalizingAck, reason });
      const finalizingResult = yield* Deferred.await(finalizingAck).pipe(
        Effect.timeoutOption("2 seconds"),
      );
      if (finalizingResult._tag === "None") {
        yield* deps.logger.warn("progress worker finalization timed out", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
        });
      }
      return;
    }

    yield* deps.logger.warn("progress worker exited before finalization", {
      channelId: session.channelId,
      sessionId: session.opencode.sessionId,
      exit: String(progressFiberExit),
    });
  });

export const executeRunBatch =
  (deps: RunExecutorDeps) =>
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
      const progressFiber = yield* deps
        .runProgressWorker(session, originMessage, session.workdir, progressQueue)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const finalizeProgress = (reason?: RunFinalizationReason) =>
        finishProgressWorker(deps, session, progressQueue, progressFiber, reason);
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
        typing: deps.startTyping(originMessage),
        finalizeProgress,
        questionOutcome: noQuestionOutcome(),
        interruptRequested: false,
        interruptSource: null,
      };
      yield* deps.setActiveRun(session, activeRun);

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
              yield* deps.sendFinalResponse(promptContext.replyTargetMessage, result.transcript);
              break;
            case "send-question-ui-failure":
              yield* deps.sendQuestionUiFailure(
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
        const result = yield* deps.runPrompts({
          channelId: session.channelId,
          session: session.opencode,
          activeRun,
          initialRequests,
          handlePromptCompleted,
        });

        if (activeRun.interruptRequested) {
          activeRun.interruptRequested = false;
          activeRun.interruptSource = null;
          yield* deps.logger.warn("interrupt request did not stop run", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
          });
        }

        yield* stopTyping;
        yield* finalizeProgress();
        yield* deps.logger.info("completed run", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          opencodeMessageId: result.messageId,
        });
      }).pipe(Effect.result);

      if (runResult._tag === "Failure") {
        const error = runResult.failure;
        if (activeRun.interruptRequested) {
          const interruptSource = activeRun.interruptSource ?? "user";
          activeRun.interruptRequested = false;
          activeRun.interruptSource = null;
          yield* deps.logger.info("interrupted run", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: deps.formatError(error),
          });
          yield* stopTyping;
          yield* finalizeProgress("interrupted");
          yield* deps.sendRunInterruptedInfo(originMessage, interruptSource);
        } else {
          yield* deps.logger.error("run failed", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: deps.formatError(error),
          });
          yield* stopTyping;
          yield* deps.sendRunFailure(currentPromptReplyTargetMessage(activeRun), error);
          failed = true;
        }
      }

      yield* stopTyping;
      yield* deps.terminateQuestionBatches(session.opencode.sessionId);
      yield* deps.setActiveRun(session, null);
      yield* Fiber.interrupt(progressFiber);

      if (failed) {
        yield* deps.ensureSessionHealthAfterFailure(session, originMessage).pipe(Effect.ignore);
      }
    });
