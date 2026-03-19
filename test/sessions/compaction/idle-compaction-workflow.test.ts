import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Layer, Ref } from "effect";
import type { Message, SendableChannels } from "discord.js";

import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards, type InfoCardsShape } from "@/discord/info-cards.ts";
import { makeIdleCompactionWorkflow } from "@/sessions/compaction/idle-compaction-workflow.ts";
import { OpencodeService, type OpencodeServiceShape } from "@/opencode/service.ts";
import type { ChannelSession } from "@/sessions/session.ts";
import { Logger } from "@/util/logging.ts";
import { getRef, makeSessionHandle, makeSilentLogger } from "../../support/fixtures.ts";
import { unsafeStub } from "../../support/stub.ts";

const makeSession = (): ChannelSession =>
  unsafeStub<ChannelSession>({
    channelId: "channel-1",
    opencode: makeSessionHandle(),
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

describe("makeIdleCompactionWorkflow", () => {
  test("clears active state when card post and compaction both fail", async () => {
    const workflow = await Effect.runPromise(
      makeIdleCompactionWorkflow().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(InfoCards, {
              send: () => Effect.fail(new Error("unexpected")),
              edit: () => Effect.void,
              upsert: () => Effect.fail(new Error("channel send failed")),
            } satisfies InfoCardsShape),
            Layer.succeed(Logger, makeSilentLogger()),
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
    const card = unsafeStub<Message>({ id: "card-1" });
    const workflow = await Effect.runPromise(
      makeIdleCompactionWorkflow().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(InfoCards, {
              send: () => Effect.fail(new Error("unexpected")),
              edit: () => Effect.void,
              upsert: () => Effect.succeed(card),
            } satisfies InfoCardsShape),
            Layer.succeed(Logger, makeSilentLogger()),
            Layer.succeed(OpencodeService, {
              createSession: () => Effect.fail(new Error("unexpected")),
              attachSession: () => Effect.fail(new Error("unexpected")),
              submitPrompt: () => Effect.fail(new Error("unexpected")),
              readPromptResult: () => Effect.fail(new Error("unexpected")),
              interruptSession: () => Effect.fail(new Error("interrupt failed")),
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
    await Effect.runPromise(workflow.start({ session, channel }));
    const result = await Effect.runPromise(workflow.requestInterrupt({ session }));

    expect(result).toEqual({
      type: "failed",
      message: formatErrorResponse("## ❌ Failed to interrupt compaction", "interrupt failed"),
    });
  });

  test("ignores a late compaction card attachment after shutdown", async () => {
    const allowCardPost = await Effect.runPromise(Deferred.make<void>());
    const edits = await Effect.runPromise(Ref.make<string[]>([]));
    const workflow = await Effect.runPromise(
      makeIdleCompactionWorkflow().pipe(
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
            Layer.succeed(Logger, makeSilentLogger()),
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
    await Effect.runPromise(Deferred.succeed(allowCardPost, undefined).pipe(Effect.ignore));

    await startPromise;
    expect(await getRef(edits)).toEqual([]);
  });

  test("prunes completed workflows so later interrupts do not hit opencode", async () => {
    const interruptCalls = await Effect.runPromise(Ref.make(0));
    const workflow = await Effect.runPromise(
      makeIdleCompactionWorkflow().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(InfoCards, {
              send: () => Effect.fail(new Error("unexpected")),
              edit: () => Effect.void,
              upsert: () => Effect.fail(new Error("channel send failed")),
            } satisfies InfoCardsShape),
            Layer.succeed(Logger, makeSilentLogger()),
            Layer.succeed(OpencodeService, {
              createSession: () => Effect.fail(new Error("unexpected")),
              attachSession: () => Effect.fail(new Error("unexpected")),
              submitPrompt: () => Effect.fail(new Error("unexpected")),
              readPromptResult: () => Effect.fail(new Error("unexpected")),
              interruptSession: () =>
                Ref.update(interruptCalls, (count) => count + 1).pipe(Effect.asVoid),
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

    const result = await Effect.runPromise(workflow.requestInterrupt({ session }));
    expect(result).toEqual({
      type: "failed",
      message: "No active OpenCode run or compaction is running in this channel.",
    });
    expect(await getRef(interruptCalls)).toBe(0);
  });
});
