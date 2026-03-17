import type { Message, SendableChannels } from "discord.js";
import { Effect, Ref, ServiceMap } from "effect";

import { compactionCardContent } from "@/discord/compaction-card.ts";
import { formatErrorResponse } from "@/discord/formatting.ts";
import { formatCompactionSummary } from "@/discord/progress.ts";
import { sendChannelProgressUpdate } from "@/discord/messages.ts";
import { InfoCards } from "@/discord/info-cards.ts";
import { OpencodeService } from "@/opencode/service.ts";
import type { ChannelSession } from "@/sessions/session.ts";
import type { LoggerShape } from "@/util/logging.ts";
import { formatError } from "@/util/errors.ts";
import { Logger } from "@/util/logging.ts";

export type IdleCompactionWorkflowStartResult =
  | { type: "started" }
  | { type: "rejected"; message: string };

export type IdleCompactionWorkflowInterruptResult =
  | { type: "interrupted" }
  | { type: "failed"; message: string };

export type IdleCompactionWorkflowShape = {
  hasActive: (sessionId: string) => Effect.Effect<boolean, unknown>;
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

type IdleCompactionStateDeps = {
  hasIdleCompaction: (sessionId: string) => Effect.Effect<boolean, unknown>;
  beginIdleCompaction: (sessionId: string) => Effect.Effect<void, unknown>;
  getIdleCompactionCard: (sessionId: string) => Effect.Effect<Message | null, unknown>;
  setIdleCompactionCard: (sessionId: string, card: Message | null) => Effect.Effect<void, unknown>;
  completeIdleCompaction: (
    sessionId: string,
  ) => Effect.Effect<{ card: Message | null; interruptRequested: boolean } | null, unknown>;
  setIdleCompactionInterruptRequested: (
    sessionId: string,
    requested: boolean,
  ) => Effect.Effect<void, unknown>;
  getIdleCompactionInterruptRequested: (sessionId: string) => Effect.Effect<boolean, unknown>;
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

export const makeIdleCompactionWorkflow = (
  deps: IdleCompactionStateDeps,
): Effect.Effect<IdleCompactionWorkflowShape, never, InfoCards | Logger | OpencodeService> =>
  Effect.gen(function* () {
    const infoCards = yield* InfoCards;
    const logger = yield* Logger;
    const opencode = yield* OpencodeService;
    const lateFinalizersRef = yield* Ref.make(new Map<string, { title: string; body: string }>());
    const shutdownStartedRef = yield* Ref.make(false);

    const finalizeCard = (sessionId: string, title: string, body: string) =>
      deps.completeIdleCompaction(sessionId).pipe(
        Effect.flatMap((compaction) => {
          if (!compaction) {
            return Effect.void;
          }

          if (!compaction.card) {
            return Ref.get(shutdownStartedRef).pipe(
              Effect.flatMap((shutdownStarted) =>
                shutdownStarted
                  ? Effect.void
                  : Ref.update(lateFinalizersRef, (current) => {
                      const next = new Map(current);
                      next.set(sessionId, { title, body });
                      return next;
                    }),
              ),
            );
          }

          return infoCards.edit(compaction.card, title, body).pipe(
            Effect.catch((error) =>
              logger.warn("failed to finalize idle compaction card", {
                sessionId,
                error: formatError(error),
              }),
            ),
          );
        }),
      );

    const completeWithoutCard = (sessionId: string) =>
      deps.completeIdleCompaction(sessionId).pipe(
        Effect.andThen(
          Ref.update(lateFinalizersRef, (current) => {
            if (!current.has(sessionId)) {
              return current;
            }
            const next = new Map(current);
            next.delete(sessionId);
            return next;
          }),
        ),
        Effect.asVoid,
      );

    const attachCard = (sessionId: string, card: Message | null) =>
      Ref.get(shutdownStartedRef).pipe(
        Effect.flatMap((shutdownStarted) =>
          shutdownStarted
            ? Effect.void
            : deps.setIdleCompactionCard(sessionId, card).pipe(
                Effect.andThen(
                  !card
                    ? Effect.void
                    : Ref.modify(
                        lateFinalizersRef,
                        (
                          current,
                        ): readonly [
                          { title: string; body: string } | null,
                          Map<string, { title: string; body: string }>,
                        ] => {
                          const pending = current.get(sessionId) ?? null;
                          if (!pending) {
                            return [null, current];
                          }

                          const next = new Map(current);
                          next.delete(sessionId);
                          return [pending, next];
                        },
                      ).pipe(
                        Effect.flatMap((pending) =>
                          pending
                            ? infoCards.edit(card, pending.title, pending.body).pipe(
                                Effect.catch((error) =>
                                  logger.warn("failed to finalize late idle compaction card", {
                                    sessionId,
                                    error: formatError(error),
                                  }),
                                ),
                              )
                            : Effect.void,
                        ),
                      ),
                ),
              ),
        ),
      );

    const updateCard = (sessionId: string, title: string, body: string) =>
      deps.getIdleCompactionCard(sessionId).pipe(
        Effect.flatMap((card) => {
          if (!card) {
            return Effect.void;
          }

          return infoCards.edit(card, title, body).pipe(
            Effect.catch((error) =>
              logger.warn("failed to update idle compaction card", {
                sessionId,
                error: formatError(error),
              }),
            ),
          );
        }),
      );

    return {
      hasActive: deps.hasIdleCompaction,
      start: ({ session, channel }) =>
        Effect.gen(function* () {
          const healthy = yield* opencode.isHealthy(session.opencode);
          if (!healthy) {
            return {
              type: "rejected",
              message:
                "This channel session is unavailable right now. Send a normal message to recreate it.",
            } satisfies IdleCompactionWorkflowStartResult;
          }

          yield* deps.beginIdleCompaction(session.opencode.sessionId);
          const existingCard = yield* deps.getIdleCompactionCard(session.opencode.sessionId);
          const compactingCard = compactionCardContent("compacting");
          const compactedCard = compactionCardContent("compacted");
          const compactionCard = yield* infoCards
            .upsert({
              channel,
              existingCard,
              title: compactingCard.title,
              body: compactingCard.body,
            })
            .pipe(
              Effect.tap((card) => attachCard(session.opencode.sessionId, card)),
              Effect.catch((error) =>
                logger
                  .warn("failed to post idle compaction card", {
                    channelId: session.channelId,
                    sessionId: session.opencode.sessionId,
                    error: formatError(error),
                  })
                  .pipe(Effect.as(null)),
              ),
            );
          const finalizeStartedCompaction = (title: string, body: string) =>
            compactionCard
              ? finalizeCard(session.opencode.sessionId, title, body)
              : completeWithoutCard(session.opencode.sessionId);

          yield* opencode.compactSession(session.opencode).pipe(
            Effect.tap(() => finalizeStartedCompaction(compactedCard.title, compactedCard.body)),
            Effect.tapError((error) =>
              logger.error("failed to compact session", {
                channelId: session.channelId,
                sessionId: session.opencode.sessionId,
                error: formatError(error),
              }),
            ),
            Effect.catch((error) =>
              deps.getIdleCompactionInterruptRequested(session.opencode.sessionId).pipe(
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
          yield* deps.setIdleCompactionInterruptRequested(session.opencode.sessionId, true);
          const interruptingCard = compactionCardContent("interrupting");
          yield* updateCard(
            session.opencode.sessionId,
            interruptingCard.title,
            interruptingCard.body,
          );

          const interruptResult = yield* opencode
            .interruptSession(session.opencode)
            .pipe(Effect.result);
          if (interruptResult._tag === "Failure") {
            yield* deps.setIdleCompactionInterruptRequested(session.opencode.sessionId, false);
            const compactingCard = compactionCardContent("compacting");
            yield* updateCard(
              session.opencode.sessionId,
              compactingCard.title,
              compactingCard.body,
            );
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
      handleCompacted: (sessionId) => {
        const compactedCard = compactionCardContent("compacted");
        return finalizeCard(sessionId, compactedCard.title, compactedCard.body);
      },
      handleInterrupted: (sessionId) => {
        const interruptedCard = compactionCardContent("interrupted");
        return finalizeCard(sessionId, interruptedCard.title, interruptedCard.body);
      },
      emitSummary: ({ session, messageId }) => {
        if (session.emittedCompactionSummaryMessageIds.has(messageId)) {
          return Effect.void;
        }

        if (!session.channelSettings.showCompactionSummaries) {
          return Effect.sync(() => {
            session.emittedCompactionSummaryMessageIds.add(messageId);
          });
        }

        return opencode.readPromptResult(session.opencode, messageId).pipe(
          Effect.flatMap((result) => {
            const text = result.transcript.trim();
            if (!text) {
              return Effect.void;
            }

            session.emittedCompactionSummaryMessageIds.add(messageId);
            return sendCompactionSummary(session, text, logger);
          }),
          Effect.catch((error) =>
            logger.warn("failed to load compaction summary transcript", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              messageId,
              error: formatError(error),
            }),
          ),
        );
      },
      shutdown: () =>
        Ref.set(shutdownStartedRef, true).pipe(
          Effect.andThen(Ref.set(lateFinalizersRef, new Map())),
        ),
    } satisfies IdleCompactionWorkflowShape;
  });
