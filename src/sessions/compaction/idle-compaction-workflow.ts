import type { Message, SendableChannels } from "discord.js";
import { Deferred, Effect, Ref, ServiceMap } from "effect";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards, type InfoCardsShape } from "@/discord/info-cards.ts";
import { sendChannelProgressUpdate } from "@/discord/messages.ts";
import { formatCompactionSummary } from "@/discord/progress.ts";
import { OpencodeService, type OpencodeServiceShape } from "@/opencode/service.ts";
import type { ChannelSession } from "@/sessions/session.ts";
import { formatError } from "@/util/errors.ts";
import { createKeyedSingleflight } from "@/util/keyed-singleflight.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";

export type IdleCompactionWorkflowStartResult =
  | { type: "started" }
  | { type: "rejected"; message: string };

export type IdleCompactionWorkflowInterruptResult =
  | { type: "interrupted" }
  | { type: "failed"; message: string };

export type IdleCompactionWorkflowShape = {
  hasActive: (sessionId: string) => Effect.Effect<boolean, unknown>;
  awaitCompletion: (sessionId: string) => Effect.Effect<void, unknown>;
  start: (input: {
    session: ChannelSession;
    channel: SendableChannels;
  }) => Effect.Effect<IdleCompactionWorkflowStartResult, unknown>;
  requestInterrupt: (input: {
    session: ChannelSession;
  }) => Effect.Effect<IdleCompactionWorkflowInterruptResult, unknown>;
  handleCompacted: (sessionId: string) => Effect.Effect<void, unknown>;
  handleInterrupted: (sessionId: string) => Effect.Effect<void, unknown>;
  emitSummary: (input: {
    session: ChannelSession;
    messageId: string;
  }) => Effect.Effect<void, unknown>;
  shutdown: () => Effect.Effect<void, unknown>;
};

export class IdleCompactionWorkflow extends ServiceMap.Service<
  IdleCompactionWorkflow,
  IdleCompactionWorkflowShape
>()("IdleCompactionWorkflow") {}

type SessionIdleCompactionState = {
  card: Message | null;
  interruptRequested: boolean;
  completed: Deferred.Deferred<void>;
};

type SessionIdleCompactionWorkflow = {
  hasActive: () => Effect.Effect<boolean, unknown>;
  awaitCompletion: () => Effect.Effect<void, unknown>;
  start: (input: {
    session: ChannelSession;
    channel: SendableChannels;
  }) => Effect.Effect<IdleCompactionWorkflowStartResult, unknown>;
  requestInterrupt: (input: {
    session: ChannelSession;
  }) => Effect.Effect<IdleCompactionWorkflowInterruptResult, unknown>;
  handleCompacted: () => Effect.Effect<void, unknown>;
  handleInterrupted: () => Effect.Effect<void, unknown>;
  shutdown: () => Effect.Effect<void, unknown>;
};

const sendCompactionSummary = (session: ChannelSession, text: string, logger: LoggerShape) => {
  if (!session.channelSettings.showCompactionSummaries) {
    return Effect.void;
  }

  const channel = session.progressChannel;
  const formatted = formatCompactionSummary(text);
  if (!channel) {
    return logger
      .warn("dropping compaction summary without a session progress channel", {
        channelId: session.channelId,
        sessionId: session.opencode.sessionId,
      })
      .pipe(Effect.asVoid);
  }
  if (!formatted) {
    return Effect.void;
  }

  return Effect.promise(() =>
    sendChannelProgressUpdate({
      channel,
      mentionContext: session.progressMentionContext,
      text: formatted,
    }),
  ).pipe(
    Effect.catch((error) =>
      logger.warn("failed to send compaction summary", {
        channelId: session.channelId,
        sessionId: session.opencode.sessionId,
        error: formatError(error),
      }),
    ),
    Effect.asVoid,
  );
};

const createSessionIdleCompactionWorkflow = (deps: {
  infoCards: InfoCardsShape;
  logger: LoggerShape;
  opencode: OpencodeServiceShape;
  onDrained: () => Effect.Effect<void, unknown>;
}): Effect.Effect<SessionIdleCompactionWorkflow> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<SessionIdleCompactionState | null>(null);
    const lateFinalizerRef = yield* Ref.make<{ title: string; body: string } | null>(null);
    const shutdownStartedRef = yield* Ref.make(false);

    const notifyIfDrained = () =>
      Ref.get(stateRef).pipe(
        Effect.flatMap((state) =>
          state
            ? Effect.void
            : Ref.get(lateFinalizerRef).pipe(
                Effect.flatMap((lateFinalizer) => (lateFinalizer ? Effect.void : deps.onDrained())),
              ),
        ),
      );

    const takeState = () =>
      Ref.modify(
        stateRef,
        (
          current,
        ): readonly [SessionIdleCompactionState | null, SessionIdleCompactionState | null] => [
          current,
          null,
        ],
      );

    const completeState = () =>
      takeState().pipe(
        Effect.tap((state) =>
          state ? Deferred.succeed(state.completed, undefined).pipe(Effect.ignore) : Effect.void,
        ),
      );

    const finalizeCard = (title: string, body: string) =>
      completeState().pipe(
        Effect.flatMap((state) => {
          if (!state) {
            return notifyIfDrained();
          }

          if (!state.card) {
            return Ref.get(shutdownStartedRef).pipe(
              Effect.flatMap((shutdownStarted) =>
                shutdownStarted ? notifyIfDrained() : Ref.set(lateFinalizerRef, { title, body }),
              ),
            );
          }

          return deps.infoCards.edit(state.card, title, body).pipe(
            Effect.catch((error) =>
              deps.logger.warn("failed to finalize idle compaction card", {
                error: formatError(error),
              }),
            ),
            Effect.andThen(notifyIfDrained()),
          );
        }),
      );

    const completeWithoutCard = () =>
      completeState().pipe(
        Effect.andThen(Ref.set(lateFinalizerRef, null)),
        Effect.andThen(notifyIfDrained()),
        Effect.asVoid,
      );

    const attachCard = (card: Message | null) =>
      Ref.get(shutdownStartedRef).pipe(
        Effect.flatMap((shutdownStarted) =>
          shutdownStarted
            ? Effect.void
            : Ref.update(stateRef, (current) =>
                !current || current.card === card ? current : { ...current, card },
              ).pipe(
                Effect.andThen(
                  !card
                    ? Effect.void
                    : Ref.get(lateFinalizerRef).pipe(
                        Effect.flatMap((pending) =>
                          !pending
                            ? Effect.void
                            : deps.infoCards.edit(card, pending.title, pending.body).pipe(
                                Effect.catch((error) =>
                                  deps.logger.warn("failed to finalize late idle compaction card", {
                                    error: formatError(error),
                                  }),
                                ),
                                Effect.ensuring(
                                  Ref.set(lateFinalizerRef, null).pipe(
                                    Effect.andThen(notifyIfDrained()),
                                    Effect.ignore,
                                  ),
                                ),
                              ),
                        ),
                      ),
                ),
              ),
        ),
      );

    const updateCard = (title: string, body: string) =>
      Ref.get(stateRef).pipe(
        Effect.flatMap((state) =>
          !state?.card
            ? Effect.void
            : deps.infoCards.edit(state.card, title, body).pipe(
                Effect.catch((error) =>
                  deps.logger.warn("failed to update idle compaction card", {
                    error: formatError(error),
                  }),
                ),
              ),
        ),
      );

    const getInterruptRequested = () =>
      Ref.get(stateRef).pipe(Effect.map((state) => state?.interruptRequested ?? false));

    return {
      hasActive: () => Ref.get(stateRef).pipe(Effect.map(Boolean)),
      awaitCompletion: () =>
        Ref.get(stateRef).pipe(
          Effect.flatMap((state) => (state ? Deferred.await(state.completed) : Effect.void)),
        ),
      start: ({ session, channel }) =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(stateRef);
          if (existing) {
            return {
              type: "rejected",
              message: "OpenCode is already compacting this channel session.",
            } satisfies IdleCompactionWorkflowStartResult;
          }

          const healthy = yield* deps.opencode.isHealthy(session.opencode);
          if (!healthy) {
            return {
              type: "rejected",
              message:
                "This channel session is unavailable right now. Send a normal message to recreate it.",
            } satisfies IdleCompactionWorkflowStartResult;
          }

          const completed = yield* Deferred.make<void>();
          yield* Ref.set(stateRef, {
            card: null,
            interruptRequested: false,
            completed,
          });

          const existingCard = yield* Ref.get(stateRef).pipe(
            Effect.map((state) => state?.card ?? null),
          );
          const compactingCard = compactionCardContent("compacting");
          const compactedCard = compactionCardContent("compacted");
          const compactionCard = yield* deps.infoCards
            .upsert({
              channel,
              existingCard,
              title: compactingCard.title,
              body: compactingCard.body,
            })
            .pipe(
              Effect.tap((card) => attachCard(card)),
              Effect.catch((error) =>
                deps.logger
                  .warn("failed to post idle compaction card", {
                    channelId: session.channelId,
                    sessionId: session.opencode.sessionId,
                    error: formatError(error),
                  })
                  .pipe(Effect.as(null)),
              ),
            );
          const finalizeStartedCompaction = (title: string, body: string) =>
            compactionCard ? finalizeCard(title, body) : completeWithoutCard();

          yield* deps.opencode.compactSession(session.opencode).pipe(
            Effect.tap(() => finalizeStartedCompaction(compactedCard.title, compactedCard.body)),
            Effect.tapError((error) =>
              deps.logger.error("failed to compact session", {
                channelId: session.channelId,
                sessionId: session.opencode.sessionId,
                error: formatError(error),
              }),
            ),
            Effect.catch((error) =>
              getInterruptRequested().pipe(
                Effect.flatMap((interruptRequested) =>
                  interruptRequested
                    ? (() => {
                        const interruptedCard = compactionCardContent("interrupted");
                        return finalizeStartedCompaction(
                          interruptedCard.title,
                          interruptedCard.body,
                        );
                      })()
                    : finalizeStartedCompaction(
                        "❌ Session compaction failed",
                        `OpenCode could not compact this session.\n\n${formatError(error)}`,
                      ),
                ),
              ),
            ),
            Effect.forkDetach({ startImmediately: true }),
          );

          return { type: "started" } satisfies IdleCompactionWorkflowStartResult;
        }),
      requestInterrupt: ({ session }) =>
        Effect.gen(function* () {
          yield* Ref.update(stateRef, (current) =>
            !current ? current : { ...current, interruptRequested: true },
          );
          const interruptingCard = compactionCardContent("interrupting");
          yield* updateCard(interruptingCard.title, interruptingCard.body);

          const interruptResult = yield* deps.opencode
            .interruptSession(session.opencode)
            .pipe(Effect.result);
          if (interruptResult._tag === "Failure") {
            yield* Ref.update(stateRef, (current) =>
              !current ? current : { ...current, interruptRequested: false },
            );
            const compactingCard = compactionCardContent("compacting");
            yield* updateCard(compactingCard.title, compactingCard.body);
            return {
              type: "failed",
              message: formatErrorResponse(
                "## ❌ Failed to interrupt compaction",
                formatError(interruptResult.failure),
              ),
            } satisfies IdleCompactionWorkflowInterruptResult;
          }

          return { type: "interrupted" } satisfies IdleCompactionWorkflowInterruptResult;
        }),
      handleCompacted: () => {
        const compactedCard = compactionCardContent("compacted");
        return finalizeCard(compactedCard.title, compactedCard.body);
      },
      handleInterrupted: () => {
        const interruptedCard = compactionCardContent("interrupted");
        return finalizeCard(interruptedCard.title, interruptedCard.body);
      },
      shutdown: () =>
        Ref.set(shutdownStartedRef, true).pipe(
          Effect.andThen(Ref.set(lateFinalizerRef, null)),
          Effect.andThen(notifyIfDrained()),
        ),
    } satisfies SessionIdleCompactionWorkflow;
  });

export const makeIdleCompactionWorkflow = (): Effect.Effect<
  IdleCompactionWorkflowShape,
  never,
  InfoCards | Logger | OpencodeService
> =>
  Effect.gen(function* () {
    const infoCards = yield* InfoCards;
    const logger = yield* Logger;
    const opencode = yield* OpencodeService;
    const workflowCreation = createKeyedSingleflight<string>();
    const workflows = new Map<string, SessionIdleCompactionWorkflow>();

    const getWorkflow = (sessionId: string) => Effect.sync(() => workflows.get(sessionId) ?? null);

    const deleteWorkflow = (sessionId: string, workflow?: SessionIdleCompactionWorkflow) =>
      Effect.sync(() => {
        const existing = workflows.get(sessionId);
        if (!existing || (workflow && existing !== workflow)) {
          return;
        }
        workflows.delete(sessionId);
      });

    const getOrCreateWorkflow = (sessionId: string) =>
      getWorkflow(sessionId).pipe(
        Effect.flatMap((existing) =>
          existing
            ? Effect.succeed(existing)
            : workflowCreation.run(
                sessionId,
                getWorkflow(sessionId).pipe(
                  Effect.flatMap((current) =>
                    current
                      ? Effect.succeed(current)
                      : Effect.gen(function* () {
                          let workflow: SessionIdleCompactionWorkflow | null = null;
                          const created = yield* createSessionIdleCompactionWorkflow({
                            infoCards,
                            logger,
                            opencode,
                            onDrained: () =>
                              workflow ? deleteWorkflow(sessionId, workflow) : Effect.void,
                          });
                          workflow = created;
                          workflows.set(sessionId, created);
                          return created;
                        }),
                  ),
                ),
              ),
        ),
      );

    const emitCompactionSummary = (input: { session: ChannelSession; messageId: string }) => {
      if (input.session.emittedCompactionSummaryMessageIds.has(input.messageId)) {
        return Effect.void;
      }

      if (!input.session.channelSettings.showCompactionSummaries) {
        return Effect.sync(() => {
          input.session.emittedCompactionSummaryMessageIds.add(input.messageId);
        });
      }

      return opencode.readPromptResult(input.session.opencode, input.messageId).pipe(
        Effect.flatMap((result) => {
          const text = result.transcript.trim();
          if (!text) {
            return Effect.void;
          }

          input.session.emittedCompactionSummaryMessageIds.add(input.messageId);
          return sendCompactionSummary(input.session, text, logger);
        }),
        Effect.catch((error) =>
          logger.warn("failed to load compaction summary transcript", {
            channelId: input.session.channelId,
            sessionId: input.session.opencode.sessionId,
            messageId: input.messageId,
            error: formatError(error),
          }),
        ),
      );
    };

    return {
      hasActive: (sessionId) =>
        getWorkflow(sessionId).pipe(
          Effect.flatMap((workflow) => (workflow ? workflow.hasActive() : Effect.succeed(false))),
        ),
      awaitCompletion: (sessionId) =>
        getWorkflow(sessionId).pipe(
          Effect.flatMap((workflow) => (workflow ? workflow.awaitCompletion() : Effect.void)),
        ),
      start: ({ session, channel }) =>
        getOrCreateWorkflow(session.opencode.sessionId).pipe(
          Effect.flatMap((workflow) => workflow.start({ session, channel })),
        ),
      requestInterrupt: ({ session }) =>
        getWorkflow(session.opencode.sessionId).pipe(
          Effect.flatMap((workflow) =>
            workflow
              ? workflow.requestInterrupt({ session })
              : Effect.succeed({
                  type: "failed",
                  message: "No active OpenCode run or compaction is running in this channel.",
                } satisfies IdleCompactionWorkflowInterruptResult),
          ),
        ),
      handleCompacted: (sessionId) =>
        getWorkflow(sessionId).pipe(
          Effect.flatMap((workflow) => (workflow ? workflow.handleCompacted() : Effect.void)),
        ),
      handleInterrupted: (sessionId) =>
        getWorkflow(sessionId).pipe(
          Effect.flatMap((workflow) => (workflow ? workflow.handleInterrupted() : Effect.void)),
        ),
      emitSummary: emitCompactionSummary,
      shutdown: () =>
        Effect.sync(() => [...workflows.values()]).pipe(
          Effect.flatMap((loadedWorkflows) =>
            Effect.forEach(loadedWorkflows, (workflow) => workflow.shutdown(), {
              concurrency: "unbounded",
              discard: true,
            }),
          ),
        ),
    } satisfies IdleCompactionWorkflowShape;
  });
