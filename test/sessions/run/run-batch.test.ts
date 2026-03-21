import { describe, expect, test } from "bun:test";
import type { Message } from "discord.js";
import { Effect, Queue } from "effect";

import {
  admitRequestBatchToActiveRun,
  maxQueuedRunBatchSize,
  takeQueuedRunBatch,
} from "@/sessions/run/run-batch.ts";
import type { RunRequest } from "@/sessions/session.ts";
import { makeMessage } from "../../support/fixtures.ts";
import { runTestEffect } from "../../support/runtime.ts";

const makeRequest = (prompt: string, attachmentMessages: ReadonlyArray<Message>): RunRequest => ({
  message: attachmentMessages[0]!,
  prompt,
  attachmentMessages,
});

describe("admitRequestBatchToActiveRun", () => {
  test("returns the single initial prompt context and tracks all known messages", () => {
    const current = new Map<string, Message>();
    const main = makeMessage("m-1");
    const referenced = makeMessage("m-2");

    const admitted = admitRequestBatchToActiveRun(
      current,
      [makeRequest("prompt one", [main, referenced])],
      "initial",
    );

    expect(admitted).toEqual({
      kind: "initial",
      prompt: "prompt one",
      replyTargetMessage: main,
      requestMessages: [main],
    });
    expect([...current.keys()]).toEqual(["m-1", "m-2"]);
  });

  test("wraps multiple initial prompts in order and keeps the first reply target", () => {
    const current = new Map<string, Message>();
    const first = makeMessage("m-1");
    const second = makeMessage("m-2");

    const admitted = admitRequestBatchToActiveRun(
      current,
      [makeRequest("first", [first]), makeRequest("second", [second])],
      "initial",
    );

    expect(admitted.kind).toBe("initial");
    expect(admitted.prompt).toBe(
      [
        "Multiple Discord messages arrived before you responded. Read all of them and address them together in order.",
        '<discord-message index="1">\nfirst\n</discord-message>',
        '<discord-message index="2">\nsecond\n</discord-message>',
      ].join("\n\n"),
    );
    expect(admitted.replyTargetMessage).toBe(first);
    expect(admitted.requestMessages).toEqual([first, second]);
  });

  test("wraps follow-up prompts, tracks newly introduced message ids, and uses the last reply target", () => {
    const current = new Map<string, Message>([["m-1", makeMessage("m-1")]]);
    const followUp = makeMessage("m-2");
    const referenced = makeMessage("m-3");

    const admitted = admitRequestBatchToActiveRun(
      current,
      [makeRequest("later", [followUp, referenced])],
      "follow-up",
    );

    expect(admitted.kind).toBe("follow-up");
    expect(admitted.prompt).toBe(
      [
        "Additional Discord messages arrived while you were working. Read all of them, address them, and continue the task.",
        '<discord-message index="1">\nlater\n</discord-message>',
      ].join("\n\n"),
    );
    expect(admitted.replyTargetMessage).toBe(followUp);
    expect(admitted.requestMessages).toEqual([followUp]);
    expect([...current.keys()]).toEqual(["m-1", "m-2", "m-3"]);
  });

  test("uses the last queued message as the follow-up reply target", () => {
    const current = new Map<string, Message>();
    const firstFollowUp = makeMessage("m-2");
    const secondFollowUp = makeMessage("m-4");

    const admitted = admitRequestBatchToActiveRun(
      current,
      [
        makeRequest("follow-1", [firstFollowUp, makeMessage("m-3")]),
        makeRequest("follow-2", [secondFollowUp]),
      ],
      "follow-up",
    );

    expect(admitted.replyTargetMessage).toBe(secondFollowUp);
    expect(admitted.requestMessages).toEqual([firstFollowUp, secondFollowUp]);
  });

  test("dedupes repeated message ids across batches", () => {
    const repeated = makeMessage("m-2");
    const current = new Map<string, Message>([["m-1", makeMessage("m-1")]]);

    admitRequestBatchToActiveRun(
      current,
      [makeRequest("later", [repeated]), makeRequest("later again", [repeated])],
      "follow-up",
    );

    expect([...current.keys()]).toEqual(["m-1", "m-2"]);
  });

  test("tracks referenced messages even when they have no attachments", () => {
    const current = new Map<string, Message>();
    const main = makeMessage({ id: "m-1", attachmentCount: 1 });
    const referenced = makeMessage({ id: "m-2", attachmentCount: 0 });

    admitRequestBatchToActiveRun(current, [makeRequest("prompt", [main, referenced])], "initial");

    expect(current.get("m-2")).toBe(referenced);
    expect(current.get("m-2")?.attachments.size).toBe(0);
  });
});

describe("takeQueuedRunBatch", () => {
  test("caps the queued batch size and preserves remaining requests for the next drain", async () => {
    const queue = await runTestEffect(Queue.unbounded<RunRequest>());
    const requests = Array.from({ length: maxQueuedRunBatchSize + 5 }, (_, index) =>
      makeRequest(`prompt-${index + 1}`, [makeMessage(`m-${index + 1}`)]),
    );

    await runTestEffect(Queue.offerAll(queue, requests));

    const firstBatch = await runTestEffect(takeQueuedRunBatch(queue));
    const secondBatch = await runTestEffect(takeQueuedRunBatch(queue));

    expect(firstBatch).toHaveLength(maxQueuedRunBatchSize);
    expect(firstBatch[0]?.prompt).toBe("prompt-1");
    expect(firstBatch.at(-1)?.prompt).toBe(`prompt-${maxQueuedRunBatchSize}`);
    expect(secondBatch.map((request) => request.prompt)).toEqual([
      "prompt-66",
      "prompt-67",
      "prompt-68",
      "prompt-69",
      "prompt-70",
    ]);
  });
});
