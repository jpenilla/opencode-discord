import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Layer, Ref } from "effect";
import type { Message, SendableChannels } from "discord.js";

import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards, type InfoCardsShape } from "@/discord/info-cards.ts";
import { makeIdleCompactionWorkflow } from "@/sessions/idle-compaction-workflow.ts";
import { OpencodeService, type OpencodeServiceShape } from "@/opencode/service.ts";
import type { ChannelSession } from "@/sessions/session.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";
import { unsafeStub } from "../support/stub.ts";

const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref));

const makeSession = (): ChannelSession =>
  unsafeStub<ChannelSession>({
    channelId: "channel-1",
    opencode: {
      sessionId: "session-1",
      client: {} as never,
      workdir: "/home/opencode/workspace",
      backend: "bwrap",
      close: () => Effect.void,
    },
    rootDir: "/tmp/session-root",
    workdir: "/home/opencode/workspace",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    channelSettings: {
      showThinking: true,
      showCompactionSummaries: true,
    },
    progressChannel: null,
    progressMentionContext: null,
    emittedCompactionSummaryMessageIds: new Set<string>(),
    queue: {} as ChannelSession["queue"],
    activeRun: null,
  });

const makeState = async () =>
  Effect.runPromise(
    Ref.make(
      new Map<
        string,
        {
          card: Message | null;
          interruptRequested: boolean;
        }
      >(),
    ),
  );

const makeDeps = (
  state: Ref.Ref<Map<string, { card: Message | null; interruptRequested: boolean }>>,
) => ({
  hasIdleCompaction: (sessionId: string) =>
    Ref.get(state).pipe(Effect.map((current) => current.has(sessionId))),
  beginIdleCompaction: (sessionId: string) =>
    Ref.update(state, (current) => {
      if (current.has(sessionId)) {
        return current;
      }
      const next = new Map(current);
      next.set(sessionId, { card: null, interruptRequested: false });
      return next;
    }),
  getIdleCompactionCard: (sessionId: string) =>
    Ref.get(state).pipe(Effect.map((current) => current.get(sessionId)?.card ?? null)),
  setIdleCompactionCard: (sessionId: string, card: Message | null) =>
    Ref.update(state, (current) => {
      const existing = current.get(sessionId);
      if (!existing) {
        return current;
      }
      const next = new Map(current);
      next.set(sessionId, { ...existing, card });
      return next;
    }),
  completeIdleCompaction: (sessionId: string) =>
    Ref.modify(state, (current) => {
      const existing = current.get(sessionId) ?? null;
      if (!existing) {
        return [null, current] as const;
      }
      const next = new Map(current);
      next.delete(sessionId);
      return [
        {
          card: existing.card,
          interruptRequested: existing.interruptRequested,
        },
        next,
      ] as const;
    }),
  setIdleCompactionInterruptRequested: (sessionId: string, requested: boolean) =>
    Ref.update(state, (current) => {
      const existing = current.get(sessionId);
      if (!existing) {
        return current;
      }
      const next = new Map(current);
      next.set(sessionId, { ...existing, interruptRequested: requested });
      return next;
    }),
  getIdleCompactionInterruptRequested: (sessionId: string) =>
    Ref.get(state).pipe(
      Effect.map((current) => current.get(sessionId)?.interruptRequested ?? false),
    ),
});

const logger: LoggerShape = {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
};

describe("makeIdleCompactionWorkflow", () => {
  test("clears idle compaction state when card post and compaction both fail", async () => {
    const state = await makeState();
    const workflow = await Effect.runPromise(
      makeIdleCompactionWorkflow(makeDeps(state)).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(InfoCards, {
              send: () => Effect.fail(new Error("unexpected")),
              edit: () => Effect.void,
              upsert: () => Effect.fail(new Error("channel send failed")),
            } satisfies InfoCardsShape),
            Layer.succeed(Logger, logger),
            Layer.succeed(OpencodeService, {
              createSession: () => Effect.fail(new Error("unexpected")),
              attachSession: () => Effect.fail(new Error("unexpected")),
              submitPrompt: () => Effect.fail(new Error("unexpected")),
              readPromptResult: () => Effect.fail(new Error("unexpected")),
              interruptSession: () => Effect.fail(new Error("unexpected")),
              compactSession: () => Effect.fail(new Error("compaction failed")),
              replyToQuestion: () => Effect.fail(new Error("unexpected")),
              rejectQuestion: () => Effect.fail(new Error("unexpected")),
              isHealthy: () => Effect.succeed(true),
            } satisfies OpencodeServiceShape),
          ),
        ),
      ),
    );

    const session = makeSession();
    const channel = unsafeStub<SendableChannels>({ id: "channel-1" });

    await Effect.runPromise(workflow.start({ session, channel }));
    await Effect.runPromise(
      workflow.hasActive(session.opencode.sessionId).pipe(
        Effect.flatMap((active) =>
          active ? Effect.fail(new Error("compaction still active")) : Effect.void,
        ),
        Effect.eventually,
        Effect.timeoutOrElse({
          duration: "1 second",
          onTimeout: () => Effect.fail(new Error("timed out waiting for compaction to clear")),
        }),
      ),
    );
  });

  test("formats compaction interrupt failures consistently", async () => {
    const state = await makeState();
    const session = makeSession();
    await Effect.runPromise(
      Ref.set(
        state,
        new Map([
          [
            session.opencode.sessionId,
            { card: unsafeStub<Message>({ id: "card-1" }), interruptRequested: false },
          ],
        ]),
      ),
    );

    const workflow = await Effect.runPromise(
      makeIdleCompactionWorkflow(makeDeps(state)).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(InfoCards, {
              send: () => Effect.fail(new Error("unexpected")),
              edit: () => Effect.void,
              upsert: () => Effect.fail(new Error("unexpected")),
            } satisfies InfoCardsShape),
            Layer.succeed(Logger, logger),
            Layer.succeed(OpencodeService, {
              createSession: () => Effect.fail(new Error("unexpected")),
              attachSession: () => Effect.fail(new Error("unexpected")),
              submitPrompt: () => Effect.fail(new Error("unexpected")),
              readPromptResult: () => Effect.fail(new Error("unexpected")),
              interruptSession: () => Effect.fail(new Error("interrupt failed")),
              compactSession: () => Effect.fail(new Error("unexpected")),
              replyToQuestion: () => Effect.fail(new Error("unexpected")),
              rejectQuestion: () => Effect.fail(new Error("unexpected")),
              isHealthy: () => Effect.succeed(true),
            } satisfies OpencodeServiceShape),
          ),
        ),
      ),
    );

    const result = await Effect.runPromise(workflow.requestInterrupt({ session }));

    expect(result).toEqual({
      type: "failed",
      message: formatErrorResponse("## ❌ Failed to interrupt compaction", "interrupt failed"),
    });
  });

  test("ignores a late compaction card attachment after shutdown", async () => {
    const state = await makeState();
    const allowCardPost = await Effect.runPromise(Deferred.make<void>());
    const edits = await Effect.runPromise(Ref.make<string[]>([]));
    const workflow = await Effect.runPromise(
      makeIdleCompactionWorkflow(makeDeps(state)).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(InfoCards, {
              send: () => Effect.fail(new Error("unexpected")),
              edit: (_card, title) =>
                Ref.update(edits, (current) => [...current, title]).pipe(Effect.asVoid),
              upsert: () =>
                Deferred.await(allowCardPost).pipe(
                  Effect.as(unsafeStub<Message>({ id: "late-card" })),
                ),
            } satisfies InfoCardsShape),
            Layer.succeed(Logger, logger),
            Layer.succeed(OpencodeService, {
              createSession: () => Effect.fail(new Error("unexpected")),
              attachSession: () => Effect.fail(new Error("unexpected")),
              submitPrompt: () => Effect.fail(new Error("unexpected")),
              readPromptResult: () => Effect.fail(new Error("unexpected")),
              interruptSession: () => Effect.fail(new Error("unexpected")),
              compactSession: () => Effect.never,
              replyToQuestion: () => Effect.fail(new Error("unexpected")),
              rejectQuestion: () => Effect.fail(new Error("unexpected")),
              isHealthy: () => Effect.succeed(true),
            } satisfies OpencodeServiceShape),
          ),
        ),
      ),
    );

    const session = makeSession();
    const channel = unsafeStub<SendableChannels>({ id: "channel-1" });
    const startPromise = Effect.runPromise(workflow.start({ session, channel }));

    await Effect.runPromise(
      workflow.hasActive(session.opencode.sessionId).pipe(
        Effect.flatMap((active) =>
          active ? Effect.void : Effect.fail(new Error("compaction not marked active yet")),
        ),
        Effect.eventually,
        Effect.timeoutOrElse({
          duration: "1 second",
          onTimeout: () =>
            Effect.fail(new Error("timed out waiting for compaction to become active")),
        }),
      ),
    );

    await Effect.runPromise(workflow.shutdown());
    await Effect.runPromise(workflow.handleStopped(session.opencode.sessionId));
    await Effect.runPromise(Deferred.succeed(allowCardPost, undefined));
    await startPromise;

    expect(await getRef(edits)).toEqual([]);
    expect(await Effect.runPromise(workflow.hasActive(session.opencode.sessionId))).toBe(false);
  });
});
