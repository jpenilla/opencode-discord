import { describe, expect, test } from "bun:test";
import { Effect, Queue, Ref } from "effect";
import type { Message } from "discord.js";

import { enqueueRunRequest } from "@/sessions/request-routing.ts";
import type { ActiveRun, RunRequest } from "@/sessions/session.ts";

const makeRequest = (id: string): RunRequest => ({
  message: { id } as Message,
  prompt: `prompt-${id}`,
  attachmentMessages: [],
});

const makeActiveRun = async (
  acceptFollowUps: boolean,
): Promise<Pick<ActiveRun, "followUpQueue" | "acceptFollowUps">> => ({
  followUpQueue: await Effect.runPromise(Queue.unbounded<RunRequest>()),
  acceptFollowUps: await Effect.runPromise(Ref.make(acceptFollowUps)),
});

const drainQueue = <A>(queue: Queue.Queue<A>) =>
  Effect.runPromise(Queue.takeAll(queue).pipe(Effect.map((items) => [...items])));
type EnqueueableSession = Parameters<typeof enqueueRunRequest>[0];

describe("enqueueRunRequest", () => {
  test("routes to the session queue when there is no active run", async () => {
    const sessionQueue = await Effect.runPromise(Queue.unbounded<RunRequest>());
    const session = {
      queue: sessionQueue,
      activeRun: null,
    } satisfies EnqueueableSession;
    const request = makeRequest("m-1");

    const destination = await Effect.runPromise(enqueueRunRequest(session, request));

    expect(destination).toBe("session");
    expect((await drainQueue(sessionQueue)).map((item) => item.message.id)).toEqual(["m-1"]);
  });

  test("routes to the follow-up queue when the active run accepts follow-ups", async () => {
    const sessionQueue = await Effect.runPromise(Queue.unbounded<RunRequest>());
    const activeRun = await makeActiveRun(true);
    const session = {
      queue: sessionQueue,
      activeRun,
    } satisfies EnqueueableSession;
    const request = makeRequest("m-1");

    const destination = await Effect.runPromise(enqueueRunRequest(session, request));

    expect(destination).toBe("follow-up");
    expect((await drainQueue(activeRun.followUpQueue)).map((item) => item.message.id)).toEqual([
      "m-1",
    ]);
    expect(await drainQueue(sessionQueue)).toEqual([]);
  });

  test("routes to the session queue when follow-up intake is closed", async () => {
    const sessionQueue = await Effect.runPromise(Queue.unbounded<RunRequest>());
    const activeRun = await makeActiveRun(false);
    const session = {
      queue: sessionQueue,
      activeRun,
    } satisfies EnqueueableSession;
    const request = makeRequest("m-1");

    const destination = await Effect.runPromise(enqueueRunRequest(session, request));

    expect(destination).toBe("session");
    expect((await drainQueue(sessionQueue)).map((item) => item.message.id)).toEqual(["m-1"]);
    expect(await drainQueue(activeRun.followUpQueue)).toEqual([]);
  });

  test("reads the live follow-up gate on each call", async () => {
    const sessionQueue = await Effect.runPromise(Queue.unbounded<RunRequest>());
    const activeRun = await makeActiveRun(true);
    const session = {
      queue: sessionQueue,
      activeRun,
    } satisfies EnqueueableSession;

    expect(await Effect.runPromise(enqueueRunRequest(session, makeRequest("m-1")))).toBe(
      "follow-up",
    );
    await Effect.runPromise(Ref.set(activeRun.acceptFollowUps, false));
    expect(await Effect.runPromise(enqueueRunRequest(session, makeRequest("m-2")))).toBe("session");

    expect((await drainQueue(activeRun.followUpQueue)).map((item) => item.message.id)).toEqual([
      "m-1",
    ]);
    expect((await drainQueue(sessionQueue)).map((item) => item.message.id)).toEqual(["m-2"]);
  });
});
