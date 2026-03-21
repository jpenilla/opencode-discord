import { describe, expect, test } from "bun:test";
import type { GlobalEvent, PermissionRequest } from "@opencode-ai/sdk/v2";
import { Deferred, Effect, Fiber, Queue } from "effect";

import { AppConfig, type AppConfigShape } from "@/config.ts";
import { OpencodeEventQueue } from "@/opencode/events.ts";
import { summarizeOpencodeEventForLog, summarizePermissionForLog } from "@/opencode/log-summary.ts";
import {
  OpencodeClientFactory,
  makeOpencodeService,
  type OpencodeServiceShape,
  type SessionHandle,
} from "@/opencode/service.ts";
import { SandboxBackend } from "@/sandbox/common.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";
import { makeTestConfig } from "../support/config.ts";
import { runTestEffect } from "../support/runtime.ts";
import { unsafeStub } from "../support/stub.ts";

const makeConfig = (): AppConfigShape => makeTestConfig({ stateDir: "/tmp/opencode-discord-test" });

const logger: LoggerShape = {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
};

const runEffect = runTestEffect;
const runScoped = <A, E, R>(effect: Effect.Effect<A, E, R>) => runEffect(Effect.scoped(effect));
const succeedDeferred = <A>(deferred: Deferred.Deferred<A>, value: A) =>
  runEffect(Deferred.succeed(deferred, value).pipe(Effect.ignore));
const awaitDeferred = <A>(deferred: Deferred.Deferred<A>) => runEffect(Deferred.await(deferred));
const testWorkdir = "/tmp/workdir";
const testSessionTitle = "Session";

const ok = <A>(data: A) => ({ data });
const emptyEventStream = () => ({
  stream: {
    async *[Symbol.asyncIterator]() {},
  },
});

type TestClientOverrides = {
  global?: Record<string, unknown>;
  session?: Record<string, unknown>;
  question?: Record<string, unknown>;
  permission?: Record<string, unknown>;
};

const makeClient = (overrides: TestClientOverrides = {}) =>
  unsafeStub<SessionHandle["client"]>({
    global: unsafeStub<SessionHandle["client"]["global"]>({
      event: async () => emptyEventStream(),
      health: async () => ok({ healthy: true }),
      ...overrides.global,
    }),
    session: unsafeStub<SessionHandle["client"]["session"]>({
      create: async () => ok({ id: "session-1" }),
      get: async () => ok({ id: "session-1" }),
      promptAsync: async () => ok(undefined),
      message: async () => ok({ parts: [] }),
      messages: async () => ok([]),
      abort: async () => ok(true),
      summarize: async () => ok(true),
      ...overrides.session,
    }),
    question: unsafeStub<SessionHandle["client"]["question"]>({
      reply: async () => ok(true),
      reject: async () => ok(true),
      ...overrides.question,
    }),
    permission: unsafeStub<SessionHandle["client"]["permission"]>({
      reply: async () => ok(true),
      ...overrides.permission,
    }),
  });

const makeSandbox =
  (
    input: {
      launchServer?: (workdir: string) => Promise<{
        url: string;
        backend: "unsafe-dev";
        directory?: string;
        close: () => void;
      }>;
    } = {},
  ) =>
  ({ workdir }: { workdir: string }) =>
    Effect.acquireRelease(
      Effect.promise(() =>
        (
          input.launchServer ??
          (async () => ({
            url: "http://opencode.invalid",
            backend: "unsafe-dev" as const,
            directory: workdir,
            close: () => {},
          }))
        )(workdir),
      ),
      (server) =>
        Effect.sync(() => {
          server.close();
        }),
    ).pipe(
      Effect.map((server) => ({
        backend: server.backend,
        url: server.url,
        directory: server.directory ?? workdir,
      })),
    );

const makeService = (input: {
  logger?: LoggerShape;
  eventQueue?: Queue.Queue<GlobalEvent>;
  createClient?: () => SessionHandle["client"];
  sandbox?: Parameters<typeof makeSandbox>[0];
}) =>
  Effect.flatMap(
    input.eventQueue ? Effect.succeed(input.eventQueue) : Queue.unbounded<GlobalEvent>(),
    (eventQueue) =>
      makeOpencodeService.pipe(
        Effect.provideService(AppConfig, makeConfig()),
        Effect.provideService(OpencodeEventQueue, eventQueue),
        Effect.provideService(Logger, input.logger ?? logger),
        Effect.provideService(OpencodeClientFactory, {
          create: () => (input.createClient ?? (() => makeClient()))(),
        }),
        Effect.provideService(SandboxBackend, {
          startSession: makeSandbox(input.sandbox),
        }),
      ),
  );

const createSession = (service: OpencodeServiceShape) =>
  service.createSession(testWorkdir, testSessionTitle, undefined);

const makeTrackedSandbox = (onClose: () => void) => ({
  launchServer: async () => ({
    url: "http://opencode.invalid",
    backend: "unsafe-dev" as const,
    close: onClose,
  }),
});

describe("opencode log summaries", () => {
  test("logs a compact summary for tool events without raw tool payloads", () => {
    const summary = summarizeOpencodeEventForLog(
      unsafeStub<GlobalEvent["payload"]>({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "tool",
            callID: "call-1",
            tool: "webfetch",
            state: {
              status: "completed",
              input: {
                url: "https://example.com",
                response:
                  "<html><body>very large html payload that should never be logged</body></html>",
              },
              output:
                "<html><body>very large html payload that should never be logged</body></html>",
              title: "https://example.com (text/html)",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        },
      }),
    );

    expect(summary).toEqual({
      type: "message.part.updated",
      sessionId: "session-1",
      messageId: "message-1",
      partId: "part-1",
      partType: "tool",
      callId: "call-1",
      tool: "webfetch",
      status: "completed",
      title: "https://example.com (text/html)",
    });
    expect(summary).not.toHaveProperty("input");
    expect(summary).not.toHaveProperty("output");
    expect(JSON.stringify(summary)).not.toContain("very large html payload");
  });

  test("summarizes message.updated summary content without logging raw text", () => {
    const summary = summarizeOpencodeEventForLog(
      unsafeStub<GlobalEvent["payload"]>({
        type: "message.updated",
        properties: {
          info: {
            id: "message-1",
            sessionID: "session-1",
            role: "assistant",
            parentID: "message-0",
            mode: "build",
            summary: "very large assistant summary body that should not be logged verbatim",
            finish: "stop",
            time: {
              created: 1,
              completed: 2,
            },
          },
        },
      }),
    );

    expect(summary).toEqual({
      type: "message.updated",
      sessionId: "session-1",
      messageId: "message-1",
      role: "assistant",
      parentId: "message-0",
      mode: "build",
      summary: {
        kind: "text",
        chars: 68,
      },
      completed: true,
      finish: "stop",
      error: undefined,
    });
    expect(JSON.stringify(summary)).not.toContain("very large assistant summary body");
  });

  test("summarizes permission requests without logging raw payload content", () => {
    const summary = summarizePermissionForLog(
      unsafeStub<PermissionRequest>({
        id: "req-1",
        sessionID: "session-1",
        permission: "bash",
        patterns: ["bash:*"],
        metadata: {
          command:
            "curl https://example.com/some/really/long/url --data '<html>very large permission payload body</html>'",
        },
        always: ["bash:pwd"],
        tool: {
          messageID: "message-1",
          callID: "call-1",
        },
      }),
    );

    expect(summary).toEqual({
      permission: "bash",
      patterns: 1,
      always: 1,
      metadata: {
        kind: "object",
        fields: 1,
        diffs: undefined,
      },
      toolCallId: "call-1",
    });
    expect(JSON.stringify(summary)).not.toContain("very large permission payload body");
    expect(JSON.stringify(summary)).not.toContain("https://example.com/some/really/long/url");
  });
});

describe("makeOpencodeService", () => {
  test("closes bootstrapped resources when createSession is interrupted before the SDK responds", async () => {
    let abortSeen = false;
    let serverClosed = false;

    await runScoped(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<GlobalEvent>();
        const createStarted = yield* Deferred.make<void>();

        const service = yield* makeService({
          eventQueue,
          createClient: () =>
            makeClient({
              global: {
                event: async ({ signal }: { signal: AbortSignal }) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      abortSeen = true;
                    },
                    { once: true },
                  );

                  return {
                    stream: {
                      async *[Symbol.asyncIterator]() {
                        yield* [];
                        await new Promise(() => {});
                      },
                    },
                  };
                },
              },
              session: {
                create: async () => {
                  await succeedDeferred(createStarted, undefined);
                  return await new Promise(() => {});
                },
              },
            }),
          sandbox: makeTrackedSandbox(() => {
            serverClosed = true;
          }),
        });

        const fiber = yield* createSession(service).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Deferred.await(createStarted);
        yield* Fiber.interrupt(fiber);

        expect(abortSeen).toBe(true);
        expect(serverClosed).toBe(true);
      }),
    );
  });

  test("keeps the session event stream alive after createSession returns and closes it via the handle", async () => {
    const event = unsafeStub<GlobalEvent>({
      payload: {
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: {
            type: "idle",
          },
        },
      },
    });

    await runScoped(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<GlobalEvent>();
        const streamStarted = yield* Deferred.make<void>();
        const firstEvent = yield* Deferred.make<IteratorResult<GlobalEvent, undefined>>();
        let firstPull = true;
        let pendingNext: ((result: IteratorResult<GlobalEvent, undefined>) => void) | null = null;
        let abortSeen = false;

        const service = yield* makeService({
          eventQueue,
          createClient: () =>
            makeClient({
              global: {
                event: async ({ signal }: { signal: AbortSignal }) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      abortSeen = true;
                      pendingNext?.({ done: true, value: undefined });
                    },
                    { once: true },
                  );

                  return {
                    stream: {
                      [Symbol.asyncIterator]: () => ({
                        next: async () => {
                          await succeedDeferred(streamStarted, undefined);
                          if (firstPull) {
                            firstPull = false;
                            return await awaitDeferred(firstEvent);
                          }
                          return await new Promise<IteratorResult<GlobalEvent, undefined>>(
                            (resolve) => {
                              pendingNext = resolve;
                            },
                          );
                        },
                      }),
                    },
                  };
                },
              },
            }),
        });

        const session = yield* createSession(service);
        yield* Deferred.await(streamStarted);
        yield* Deferred.succeed(firstEvent, { done: false, value: event }).pipe(Effect.ignore);

        expect(yield* Queue.take(eventQueue)).toEqual(event);

        yield* session.close();
        expect(abortSeen).toBe(true);
      }),
    );
  });

  test("does not warn when closing a session aborts a rejecting event stream", async () => {
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];

    await runScoped(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<GlobalEvent>();
        const streamStarted = yield* Deferred.make<void>();
        let rejectNext: ((error: unknown) => void) | null = null;

        const service = yield* makeService({
          eventQueue,
          logger: {
            info: () => Effect.void,
            warn: (message, fields) =>
              Effect.sync(() => {
                warnings.push({ message, fields });
              }),
            error: () => Effect.void,
          },
          createClient: () =>
            makeClient({
              global: {
                event: async ({ signal }: { signal: AbortSignal }) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      rejectNext?.(new DOMException("Aborted", "AbortError"));
                    },
                    { once: true },
                  );

                  return {
                    stream: {
                      [Symbol.asyncIterator]: () => ({
                        next: async () => {
                          await succeedDeferred(streamStarted, undefined);
                          return await new Promise<IteratorResult<GlobalEvent, undefined>>(
                            (_resolve, reject) => {
                              rejectNext = reject;
                            },
                          );
                        },
                      }),
                    },
                  };
                },
              },
            }),
        });

        const session = yield* createSession(service);
        yield* Deferred.await(streamStarted);
        yield* session.close();
      }),
    );

    expect(
      warnings.filter((entry) => entry.message === "opencode event stream closed unexpectedly"),
    ).toEqual([]);
  });

  test("closes the sandbox session when bootstrap fails after startup", async () => {
    let serverClosed = false;

    await expect(
      Effect.gen(function* () {
        const service = yield* makeService({
          createClient: () => {
            throw new Error("client init failed");
          },
          sandbox: makeTrackedSandbox(() => {
            serverClosed = true;
          }),
        });

        yield* createSession(service);
      }).pipe(runScoped),
    ).rejects.toThrow("client init failed");

    expect(serverClosed).toBe(true);
  });

  test("surfaces SDK result errors through the Effect failure channel", async () => {
    await runScoped(
      Effect.gen(function* () {
        const service = yield* makeService({
          createClient: () =>
            makeClient({
              session: {
                abort: async () => ({
                  data: false,
                  error: "already stopped",
                }),
              },
            }),
        });
        const session = yield* createSession(service);

        const result = yield* service.interruptSession(session).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
        });

        yield* session.close();
      }),
    );
  });
});
