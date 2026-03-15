import { describe, expect, test } from "bun:test";
import type { Message } from "discord.js";

import { admitRequestBatchToActiveRun } from "@/sessions/run-batch.ts";
import type { RunRequest } from "@/sessions/session.ts";
import { unsafeStub } from "../support/stub.ts";

const makeMessage = (id: string, attachmentCount = 0) =>
  unsafeStub<Message>({
    id,
    attachments: new Map(
      Array.from({ length: attachmentCount }, (_, index) => [
        `att-${id}-${index}`,
        { id: `att-${id}-${index}` },
      ]),
    ),
  });

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
    const main = makeMessage("m-1", 1);
    const referenced = makeMessage("m-2", 0);

    admitRequestBatchToActiveRun(current, [makeRequest("prompt", [main, referenced])], "initial");

    expect(current.get("m-2")).toBe(referenced);
    expect(current.get("m-2")?.attachments.size).toBe(0);
  });
});
