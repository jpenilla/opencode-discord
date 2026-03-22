import type { Message, SendableChannels } from "discord.js";
import { Deferred, Effect, Fiber, FileSystem, Option, Path, Queue, Ref, Result } from "effect";

import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards } from "@/discord/info-card.ts";
import { sendFinalResponse, startTypingLoop, type TypingLoop } from "@/discord/messages.ts";
import type { PromptResult, SessionHandle } from "@/opencode/service.ts";
import { OpencodeService } from "@/opencode/service.ts";
import { IdleCompactionWorkflow } from "@/sessions/compaction/idle-compaction-workflow.ts";
import type { AdmittedPromptContext } from "@/sessions/run/prompt-context.ts";
import { coordinateActiveRunPrompts } from "@/sessions/run/prompt-coordinator.ts";
import { runProgressWorker } from "@/sessions/run/progress.ts";
import type { PendingPrompt } from "@/sessions/run/prompt-state.ts";
import type { NonEmptyRunRequestBatch } from "@/sessions/run/run-batch.ts";
import { decideRunCompletion } from "@/sessions/run/run-completion.ts";
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
import { formatError } from "@/util/errors.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";

type FsEnv = FileSystem.FileSystem | Path.Path;

const finishProgressWorker = (
  session: ChannelSession,
  progressQueue: Queue.Queue<RunProgressEvent>,
  progressFiber: Fiber.Fiber<unknown, unknown>,
  logger: LoggerShape,
  reason?: RunFinalizationReason,
) =>
  Effect.gen(function* () {
    const progressFiberExit = yield* Effect.sync(() => progressFiber.pollUnsafe());
    if (progressFiberExit === undefined) {
      const finalizingAck = yield* Deferred.make<void>();
      yield* Queue.offer(progressQueue, {
        type: "run-finalizing",
        ack: finalizingAck,
        reason,
      });
      const finalizingResult = yield* Deferred.await(finalizingAck).pipe(
        Effect.timeoutOption("2 seconds"),
      );
      if (Option.isNone(finalizingResult)) {
        yield* logger.warn("progress worker finalization timed out", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
        });
      }
      return;
    }

    yield* logger.warn("progress worker exited before finalization", {
      channelId: session.channelId,
      sessionId: session.opencode.sessionId,
      exit: String(progressFiberExit),
    });
  });

export const executeRunBatch =
  (
    runPrompts: (input: {
      channelId: string;
      session: SessionHandle;
      activeRun: ActiveRun;
      initialRequests: NonEmptyRunRequestBatch;
      handlePromptCompleted: (
        promptContext: AdmittedPromptContext,
        result: PromptResult,
      ) => Effect.Effect<void, unknown>;
    }) => Effect.Effect<PromptResult, unknown>,
    runProgress: (
      channel: SendableChannels,
      channelSession: Pick<ChannelSession, "channelSettings" | "opencode" | "workdir">,
      message: Message,
      queue: Queue.Queue<RunProgressEvent>,
    ) => Effect.Effect<unknown, unknown>,
    startTyping: (message: Message) => TypingLoop,
    setActiveRun: (
      session: ChannelSession,
      activeRun: ActiveRun | null,
    ) => Effect.Effect<void, unknown>,
    terminateQuestions: (sessionId: string) => Effect.Effect<void, unknown>,
    recoverSession: (
      session: ChannelSession,
      responseMessage: Message,
    ) => Effect.Effect<void, unknown, FsEnv>,
    sendInterrupted: (message: Message, source: RunInterruptSource) => Effect.Effect<void, unknown>,
    sendFinal: (message: Message, text: string) => Effect.Effect<void, unknown>,
    sendRunFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>,
    sendUiFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>,
    logger: LoggerShape,
  ) =>
  (
    session: ChannelSession,
    initialRequests: NonEmptyRunRequestBatch,
  ): Effect.Effect<void, unknown, FsEnv> =>
    Effect.gen(function* () {
      const progressQueue = yield* Queue.unbounded<RunProgressEvent>();
      const promptState = yield* Ref.make<PendingPrompt | null>(null);
      const followUpQueue = yield* Queue.unbounded<RunRequest>();
      const acceptFollowUps = yield* Ref.make(true);
      const originMessage = initialRequests[0]!.message;
      const originChannel = originMessage.channel;
      if (!originChannel.isSendable()) {
        return yield* Effect.fail("Channel is not sendable");
      }
      const progressFiber = yield* runProgress(
        originChannel,
        session,
        originMessage,
        progressQueue,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      const finalizeProgress = (reason?: RunFinalizationReason) =>
        finishProgressWorker(session, progressQueue, progressFiber, logger, reason);
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
        typing: startTyping(originMessage),
        finalizeProgress,
        questionOutcome: noQuestionOutcome(),
        interruptRequested: false,
        interruptSource: null,
      };
      yield* setActiveRun(session, activeRun);

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
              yield* sendFinal(promptContext.replyTargetMessage, result.transcript);
              break;
            case "send-question-ui-failure":
              yield* sendUiFailure(promptContext.replyTargetMessage, completion.message);
              break;
            case "suppress-response":
              break;
          }

          activeRun.questionOutcome = noQuestionOutcome();
        });

      const runResult = yield* Effect.gen(function* () {
        const result = yield* runPrompts({
          channelId: session.channelId,
          session: session.opencode,
          activeRun,
          initialRequests,
          handlePromptCompleted,
        });

        if (activeRun.interruptRequested) {
          activeRun.interruptRequested = false;
          activeRun.interruptSource = null;
          yield* logger.warn("interrupt request did not stop run", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
          });
        }

        yield* stopTyping;
        yield* finalizeProgress();
        yield* logger.info("completed run", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          opencodeMessageId: result.messageId,
        });
      }).pipe(Effect.result);

      if (Result.isFailure(runResult)) {
        const error = runResult.failure;
        if (activeRun.interruptRequested) {
          const interruptSource = activeRun.interruptSource ?? "user";
          activeRun.interruptRequested = false;
          activeRun.interruptSource = null;
          yield* logger.info("interrupted run", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: formatError(error),
          });
          yield* stopTyping;
          yield* finalizeProgress("interrupted");
          yield* sendInterrupted(originMessage, interruptSource);
        } else {
          yield* logger.error("run failed", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            error: formatError(error),
          });
          yield* stopTyping;
          yield* sendRunFailure(currentPromptReplyTargetMessage(activeRun), error);
          failed = true;
        }
      }

      yield* stopTyping;
      yield* terminateQuestions(session.opencode.sessionId);
      yield* setActiveRun(session, null);
      yield* Fiber.interrupt(progressFiber);

      if (failed) {
        yield* recoverSession(session, originMessage).pipe(Effect.ignore);
      }
    });

export const makeRunOrchestrator = (input: {
  setActiveRun: (
    session: ChannelSession,
    activeRun: ActiveRun | null,
  ) => Effect.Effect<void, unknown>;
  terminateQuestions: (sessionId: string) => Effect.Effect<void, unknown>;
  recoverSession: (
    session: ChannelSession,
    responseMessage: Message,
  ) => Effect.Effect<void, unknown, FsEnv>;
}) =>
  Effect.gen(function* () {
    const idleCompaction = yield* IdleCompactionWorkflow;
    const infoCards = yield* InfoCards;
    const logger = yield* Logger;
    const opencode = yield* OpencodeService;

    const replyWithError = (title: string) => (message: Message, error: unknown) =>
      Effect.promise(() =>
        message.reply({
          content: formatErrorResponse(title, formatError(error)),
          allowedMentions: { repliedUser: false, parse: [] },
        }),
      );

    return executeRunBatch(
      ({ channelId, session, activeRun, initialRequests, handlePromptCompleted }) =>
        coordinateActiveRunPrompts({
          channelId,
          session,
          activeRun,
          initialRequests,
          awaitIdleCompaction: idleCompaction.awaitCompletion,
          submitPrompt: opencode.submitPrompt,
          handlePromptCompleted,
          logger,
        }),
      runProgressWorker,
      (message) => startTypingLoop(message.channel),
      input.setActiveRun,
      input.terminateQuestions,
      input.recoverSession,
      (message, source) =>
        infoCards
          .send(
            message.channel as SendableChannels,
            source === "shutdown" ? "🛑 Run interrupted" : "‼️ Run interrupted",
            source === "shutdown"
              ? "OpenCode stopped the active run in this channel because the bot is shutting down."
              : "OpenCode stopped the active run in this channel.",
          )
          .pipe(
            Effect.catch((error) =>
              logger.warn("failed to post interrupt info card", {
                channelId: message.channelId,
                error: formatError(error),
              }),
            ),
            Effect.ignore,
          ),
      (message, text) => Effect.promise(() => sendFinalResponse({ message, text })),
      replyWithError("## ❌ Opencode failed"),
      replyWithError("## ❌ Failed to show questions"),
      logger,
    );
  });
