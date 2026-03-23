import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Layer, Ref } from "effect";
import type { Message, SendableChannels } from "discord.js";

import { formatErrorResponse } from "@/discord/formatting.ts";
import { InfoCards, type InfoCardsShape } from "@/discord/info-card.ts";
import { makeSessionCompactionWorkflow } from "@/sessions/compaction/workflow.ts";
import { OpencodeService, type OpencodeServiceShape } from "@/opencode/service.ts";
import { Logger } from "@/util/logging.ts";
import { failTest, timeoutTestError } from "../../support/errors.ts";
import { getRef, makeSilentLogger } from "../../support/fixtures.ts";
import { makeTestSession } from "../../support/session.ts";
import { unsafeStub } from "../../support/stub.ts";

const makeSession = () => makeTestSession();
const makeChannel = () => unsafeStub<SendableChannels>({ id: "channel-1" });
const makeOpencode = (overrides: Partial<OpencodeServiceShape> = {}): OpencodeServiceShape => ({
  createSession: () => failTest("unexpected"),
  attachSession: () => failTest("unexpected"),
  submitPrompt: () => failTest("unexpected"),
  readPromptResult: () => failTest("unexpected"),
  interruptSession: () => failTest("unexpected"),
  compactSession: () => failTest("unexpected"),
  replyToQuestion: () => failTest("unexpected"),
  rejectQuestion: () => failTest("unexpected"),
  isHealthy: () => Effect.succeed(true),
  ...overrides,
});
const makeWorkflow = (input: {
  session: ReturnType<typeof makeSession>;
  infoCards: InfoCardsShape;
  opencode?: Partial<OpencodeServiceShape>;
}) =>
  Effect.runPromise(
    makeSessionCompactionWorkflow(() => input.session).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(InfoCards, input.infoCards),
          Layer.succeed(Logger, makeSilentLogger()),
          Layer.succeed(OpencodeService, makeOpencode(input.opencode)),
        ),
      ),
    ),
  );
const expectEventuallyActive = (hasActive: () => Effect.Effect<boolean, unknown>) =>
  Effect.runPromise(
    hasActive().pipe(
      Effect.flatMap((active) =>
        active ? Effect.void : failTest("compaction not marked active yet"),
      ),
      Effect.eventually,
      Effect.timeoutOrElse({
        duration: "1 second",
        onTimeout: () =>
          Effect.fail(timeoutTestError("timed out waiting for compaction to become active")),
      }),
    ),
  );
const expectEventuallyInactive = (hasActive: () => Effect.Effect<boolean, unknown>) =>
  Effect.runPromise(
    hasActive().pipe(
      Effect.flatMap((active) => (active ? failTest("compaction still active") : Effect.void)),
      Effect.eventually,
      Effect.timeoutOrElse({
        duration: "1 second",
        onTimeout: () => Effect.fail(timeoutTestError("timed out waiting for compaction to clear")),
      }),
    ),
  );

describe("makeSessionCompactionWorkflow", () => {
  test("clears active state when card post and compaction both fail", async () => {
    const session = makeSession();
    const workflow = await makeWorkflow({
      session,
      infoCards: {
        send: () => failTest("unexpected"),
        edit: () => Effect.void,
        upsert: () => failTest("channel send failed"),
      },
      opencode: { compactSession: () => failTest("compaction failed") },
    });

    const channel = makeChannel();

    await Effect.runPromise(workflow.start(channel));
    await expectEventuallyInactive(workflow.hasActive);
  });

  test("formats compaction interrupt failures consistently", async () => {
    const card = unsafeStub<Message>({ id: "card-1" });
    const session = makeSession();
    const workflow = await makeWorkflow({
      session,
      infoCards: {
        send: () => failTest("unexpected"),
        edit: () => Effect.void,
        upsert: () => Effect.succeed(card),
      },
      opencode: {
        interruptSession: () => failTest("interrupt failed"),
        compactSession: () => Effect.never,
      },
    });

    const channel = makeChannel();
    await Effect.runPromise(workflow.start(channel));
    const result = await Effect.runPromise(workflow.requestInterrupt());

    expect(result).toEqual({
      type: "failed",
      message: formatErrorResponse("## ❌ Failed to interrupt compaction", "interrupt failed"),
    });
  });

  test("ignores a late compaction card attachment after shutdown", async () => {
    const allowCardPost = await Effect.runPromise(Deferred.make<void>());
    const edits = await Effect.runPromise(Ref.make<string[]>([]));
    const session = makeSession();
    const workflow = await makeWorkflow({
      session,
      infoCards: {
        send: () => failTest("unexpected"),
        edit: (_card, title) =>
          Ref.update(edits, (current) => [...current, title]).pipe(Effect.asVoid),
        upsert: () =>
          Deferred.await(allowCardPost).pipe(Effect.as(unsafeStub<Message>({ id: "late-card" }))),
      },
      opencode: { compactSession: () => Effect.never },
    });

    const channel = makeChannel();
    const startPromise = Effect.runPromise(workflow.start(channel));

    await expectEventuallyActive(workflow.hasActive);
    await Effect.runPromise(workflow.shutdown());
    await Effect.runPromise(Deferred.succeed(allowCardPost, undefined).pipe(Effect.ignore));

    await startPromise;
    expect(await getRef(edits)).toEqual([]);
  });

  test("prunes completed workflows so later interrupts do not hit opencode", async () => {
    const interruptCalls = await Effect.runPromise(Ref.make(0));
    const session = makeSession();
    const workflow = await makeWorkflow({
      session,
      infoCards: {
        send: () => failTest("unexpected"),
        edit: () => Effect.void,
        upsert: () => failTest("channel send failed"),
      },
      opencode: {
        interruptSession: () =>
          Ref.update(interruptCalls, (count) => count + 1).pipe(Effect.asVoid),
        compactSession: () => failTest("compaction failed"),
      },
    });

    const channel = makeChannel();

    await Effect.runPromise(workflow.start(channel));
    await expectEventuallyInactive(workflow.hasActive);

    const result = await Effect.runPromise(workflow.requestInterrupt());
    expect(result).toEqual({
      type: "failed",
      message: "No active OpenCode run or compaction is running in this channel.",
    });
    expect(await getRef(interruptCalls)).toBe(0);
  });
});
