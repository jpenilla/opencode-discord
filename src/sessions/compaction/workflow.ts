import type { Message, SendableChannels } from "discord.js";
import { Deferred, Effect, Ref } from "effect";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards, type InfoCardsShape } from "@/discord/info-card.ts";
import { sendChannelProgressUpdate } from "@/discord/messages.ts";
import { formatCompactionSummary } from "@/discord/progress.ts";
import { OpencodeService, type OpencodeServiceShape } from "@/opencode/service.ts";
import type { ChannelSession } from "@/sessions/types.ts";
import { formatError } from "@/util/errors.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";

export type SessionCompactionStartResult =
  | { type: "started" }
  | { type: "rejected"; message: string };

export type SessionCompactionInterruptResult =
  | { type: "interrupted" }
  | { type: "failed"; message: string };

type SessionCompactionState = {
  card: Message | null;
  interruptRequested: boolean;
  completed: Deferred.Deferred<void>;
};

export type SessionCompactionWorkflow = {
  hasActive: () => Effect.Effect<boolean, unknown>;
  awaitCompletion: () => Effect.Effect<void, unknown>;
  start: (channel: SendableChannels) => Effect.Effect<SessionCompactionStartResult, unknown>;
  requestInterrupt: () => Effect.Effect<SessionCompactionInterruptResult, unknown>;
  handleCompacted: () => Effect.Effect<void, unknown>;
  handleInterrupted: () => Effect.Effect<void, unknown>;
  emitSummary: (messageId: string) => Effect.Effect<void, unknown>;
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

  return Effect.tryPromise(() =>
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

const createSessionCompactionWorkflow = (deps: {
  readSession: () => ChannelSession;
  infoCards: InfoCardsShape;
  logger: LoggerShape;
  opencode: OpencodeServiceShape;
}): Effect.Effect<SessionCompactionWorkflow> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<SessionCompactionState | null>(null);
    const lateFinalizerRef = yield* Ref.make<{ title: string; body: string } | null>(null);
    const shutdownStartedRef = yield* Ref.make(false);

    const completeState = () =>
      Ref.modify(
        stateRef,
        (current): readonly [SessionCompactionState | null, SessionCompactionState | null] => [
          current,
          null,
        ],
      ).pipe(
        Effect.tap((state) =>
          state ? Deferred.succeed(state.completed, undefined).pipe(Effect.ignore) : Effect.void,
        ),
      );

    const finalizeCard = (title: string, body: string) =>
      completeState().pipe(
        Effect.flatMap((state) => {
          if (!state) {
            return Effect.void;
          }

          if (!state.card) {
            return Ref.get(shutdownStartedRef).pipe(
              Effect.flatMap((shutdownStarted) =>
                shutdownStarted ? Effect.void : Ref.set(lateFinalizerRef, { title, body }),
              ),
            );
          }

          return deps.infoCards.edit(state.card, title, body).pipe(
            Effect.catch((error) =>
              deps.logger.warn("failed to finalize idle compaction card", {
                error: formatError(error),
              }),
            ),
          );
        }),
      );

    const completeWithoutCard = () =>
      completeState().pipe(Effect.andThen(Ref.set(lateFinalizerRef, null)), Effect.asVoid);

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
                                  Ref.set(lateFinalizerRef, null).pipe(Effect.ignore),
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
    const finalizeStatusCard = (status: "compacted" | "interrupted") => {
      const card = compactionCardContent(status);
      return finalizeCard(card.title, card.body);
    };
    const updateStatusCard = (status: "compacting" | "interrupting") => {
      const card = compactionCardContent(status);
      return updateCard(card.title, card.body);
    };
    const readSession = () => deps.readSession();

    return {
      hasActive: () => Ref.get(stateRef).pipe(Effect.map(Boolean)),
      awaitCompletion: () =>
        Ref.get(stateRef).pipe(
          Effect.flatMap((state) => (state ? Deferred.await(state.completed) : Effect.void)),
        ),
      start: (channel) =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(stateRef);
          if (existing) {
            return {
              type: "rejected",
              message: "OpenCode is already compacting this channel session.",
            } satisfies SessionCompactionStartResult;
          }

          const session = readSession();
          const healthy = yield* deps.opencode.isHealthy(session.opencode);
          if (!healthy) {
            return {
              type: "rejected",
              message:
                "This channel session is unavailable right now. Send a normal message to recreate it.",
            } satisfies SessionCompactionStartResult;
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
          const finalizeStartedStatus = (status: "compacted" | "interrupted") => {
            const card = compactionCardContent(status);
            return finalizeStartedCompaction(card.title, card.body);
          };

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
                    ? finalizeStartedStatus("interrupted")
                    : finalizeStartedCompaction(
                        "❌ Session compaction failed",
                        `OpenCode could not compact this session.\n\n${formatError(error)}`,
                      ),
                ),
              ),
            ),
            Effect.forkDetach({ startImmediately: true }),
          );

          return { type: "started" } satisfies SessionCompactionStartResult;
        }),
      requestInterrupt: () =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(stateRef);
          if (!existing) {
            return {
              type: "failed",
              message: "No active OpenCode run or compaction is running in this channel.",
            } satisfies SessionCompactionInterruptResult;
          }

          yield* Ref.update(stateRef, (current) =>
            !current ? current : { ...current, interruptRequested: true },
          );
          yield* updateStatusCard("interrupting");

          return yield* deps.opencode.interruptSession(readSession().opencode).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Ref.update(stateRef, (current) =>
                  !current ? current : { ...current, interruptRequested: false },
                ).pipe(
                  Effect.andThen(updateStatusCard("compacting")),
                  Effect.as({
                    type: "failed",
                    message: formatErrorResponse(
                      "## ❌ Failed to interrupt compaction",
                      formatError(error),
                    ),
                  } satisfies SessionCompactionInterruptResult),
                ),
              onSuccess: () =>
                Effect.succeed({
                  type: "interrupted",
                } satisfies SessionCompactionInterruptResult),
            }),
          );
        }),
      handleCompacted: () => finalizeStatusCard("compacted"),
      handleInterrupted: () => finalizeStatusCard("interrupted"),
      emitSummary: (messageId) => {
        const session = readSession();
        if (session.emittedCompactionSummaryMessageIds.has(messageId)) {
          return Effect.void;
        }

        if (!session.channelSettings.showCompactionSummaries) {
          return Effect.sync(() => {
            session.emittedCompactionSummaryMessageIds.add(messageId);
          });
        }

        return deps.opencode.readPromptResult(session.opencode, messageId).pipe(
          Effect.flatMap((result) => {
            const text = result.transcript.trim();
            if (!text) {
              return Effect.void;
            }

            session.emittedCompactionSummaryMessageIds.add(messageId);
            return sendCompactionSummary(session, text, deps.logger);
          }),
          Effect.catch((error) =>
            deps.logger.warn("failed to load compaction summary transcript", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              messageId,
              error: formatError(error),
            }),
          ),
        );
      },
      shutdown: () =>
        Ref.set(shutdownStartedRef, true).pipe(Effect.andThen(Ref.set(lateFinalizerRef, null))),
    } satisfies SessionCompactionWorkflow;
  });

export const makeSessionCompactionWorkflow = (
  readSession: () => ChannelSession,
): Effect.Effect<SessionCompactionWorkflow, never, InfoCards | Logger | OpencodeService> =>
  Effect.gen(function* () {
    const infoCards = yield* InfoCards;
    const logger = yield* Logger;
    const opencode = yield* OpencodeService;

    return yield* createSessionCompactionWorkflow({
      readSession,
      infoCards,
      logger,
      opencode,
    });
  });
