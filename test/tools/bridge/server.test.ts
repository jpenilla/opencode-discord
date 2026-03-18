import { describe, expect, test } from "bun:test";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessageCreateOptions, SendableChannels } from "discord.js";
import { Deferred, Effect, Fiber, Option, Redacted } from "effect";

import type { AppConfigShape } from "@/config.ts";
import type { ActiveRun } from "@/sessions/session.ts";
import type { SessionRuntimeShape } from "@/sessions/session-runtime.ts";
import { uploadMetadataHeader } from "@/tools/bridge/handlers/uploads.ts";
import { handleToolBridgeRequest, runToolBridgeHttpRequest } from "@/tools/bridge/server.ts";
import type { LoggerShape } from "@/util/logging.ts";
import { unsafeStub } from "../../support/stub.ts";

const bridgeToken = "bridge-token";
const uploadPath = "/tool/send-file";
const uploadMetadata = {
  sessionID: "session-1",
  filename: "large.zip",
} as const;
const discordUploadFailure = {
  status: 502,
  body: {
    error:
      "Discord rejected file upload (status 400, code 50035): Invalid Form Body\nfiles[0]: This file cannot be sent",
    kind: "discord-api",
  },
} as const;

const makeLogger = (errors: Array<Record<string, unknown>>): LoggerShape => ({
  info: () => Effect.void,
  warn: () => Effect.void,
  error: (message, context) =>
    Effect.sync(() => {
      errors.push({ message, context });
    }),
});

const makeConfig = (bridgeToken: string): AppConfigShape => ({
  discordToken: Redacted.make("discord-token"),
  triggerPhrase: "hey opencode",
  ignoreOtherBotTriggers: false,
  sessionInstructions: "",
  stateDir: join(tmpdir(), "opencode-discord-bridge-state"),
  defaultProviderId: undefined,
  defaultModelId: undefined,
  showThinkingByDefault: true,
  showCompactionSummariesByDefault: true,
  sessionIdleTimeoutMs: 30 * 60 * 1_000,
  toolBridgeSocketPath: join(tmpdir(), "unused-bridge.sock"),
  toolBridgeToken: Redacted.make(bridgeToken),
  sandboxBackend: "bwrap",
  opencodeBin: "opencode",
  bwrapBin: "bwrap",
  sandboxReadOnlyPaths: [],
  sandboxEnvPassthrough: [],
});

const makeUploadRequest = (input: {
  bridgeToken: string;
  uploadMetadata?: Record<string, unknown>;
  chunks?: Buffer[];
  requestFactory?: () => AsyncIterator<Buffer>;
}): IncomingMessage => {
  const iterator =
    input.requestFactory?.() ??
    (async function* () {
      for (const chunk of input.chunks ?? []) {
        yield chunk;
      }
    })();
  let paused = false;
  const request = unsafeStub<
    IncomingMessage & { complete: boolean; isPaused: () => boolean; pause: () => IncomingMessage }
  >({
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-opencode-discord-token": input.bridgeToken,
      ...(input.uploadMetadata
        ? {
            [uploadMetadataHeader]: Buffer.from(
              JSON.stringify(input.uploadMetadata),
              "utf8",
            ).toString("base64url"),
          }
        : {}),
    },
    complete: false,
    isPaused: () => paused,
    pause: () => {
      paused = true;
      return request;
    },
    unpipe: () => {
      paused = true;
      return request;
    },
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (paused) {
          return { done: true, value: undefined };
        }

        const next = await iterator.next();
        if (next.done) {
          request.complete = true;
        }
        return next;
      },
      return: async () => {
        paused = true;
        return { done: true, value: undefined };
      },
      throw: async (error: unknown) => {
        paused = true;
        throw error;
      },
    }),
  });
  return request;
};

const makeSessions = (
  activeRun: ActiveRun | null,
): Pick<SessionRuntimeShape, "getActiveRunBySessionId"> => ({
  getActiveRunBySessionId: (sessionId: string) =>
    Effect.succeed(sessionId === "session-1" ? activeRun : null),
});

const makeActiveRun = (send: (payload: MessageCreateOptions) => Promise<unknown>): ActiveRun =>
  unsafeStub<ActiveRun>({
    originMessage: {
      channel: unsafeStub<SendableChannels>({
        isSendable: () => true,
        send,
      }),
    },
  });

const makeDiscordApiError = () => ({
  name: "DiscordAPIError[50035]",
  message: "Invalid Form Body\nfiles[0]: This file cannot be sent",
  status: 400,
  code: 50035,
  rawError: { message: "Invalid Form Body" },
});

const runBridgeRequest = (
  input: {
    request?: IncomingMessage;
    pathname?: string;
    activeRun?: ActiveRun | null;
    loggedErrors?: Array<Record<string, unknown>>;
    configBridgeToken?: string;
  } = {},
) => {
  const configBridgeToken = input.configBridgeToken ?? bridgeToken;
  return Effect.runPromise(
    handleToolBridgeRequest({
      request:
        input.request ??
        makeUploadRequest({
          bridgeToken: configBridgeToken,
          uploadMetadata,
        }),
      pathname: input.pathname ?? uploadPath,
      config: makeConfig(configBridgeToken),
      sessions: makeSessions(input.activeRun ?? null),
      logger: makeLogger(input.loggedErrors ?? []),
    }),
  );
};

describe("handleToolBridgeRequest", () => {
  test("returns unauthorized when the bridge token is invalid", async () => {
    const response = await runBridgeRequest({
      request: makeUploadRequest({
        bridgeToken: "wrong-token",
        uploadMetadata,
      }),
    });

    expect(response).toEqual({
      status: 401,
      body: {
        error: "unauthorized",
      },
    });
  });

  test("returns not found for unknown routes", async () => {
    const response = await runBridgeRequest({
      pathname: "/tool/unknown",
    });

    expect(response).toEqual({
      status: 404,
      body: {
        error: "not found",
      },
    });
  });

  test("returns conflict when the session has no active run", async () => {
    const response = await runBridgeRequest();

    expect(response).toEqual({
      status: 409,
      body: {
        error: "no active run for session",
      },
    });
  });

  test("returns direct request validation failures without bridge classification", async () => {
    const loggedErrors: Array<Record<string, unknown>> = [];

    const response = await runBridgeRequest({
      request: makeUploadRequest({
        bridgeToken,
      }),
      loggedErrors,
    });

    expect(response).toEqual({
      status: 400,
      body: {
        error: "missing upload metadata",
      },
    });
    expect(loggedErrors).toHaveLength(0);
  });

  test("formats Discord API upload failures through the server error path", async () => {
    const discordApiError = makeDiscordApiError();
    let sendCalls = 0;
    const loggedErrors: Array<Record<string, unknown>> = [];

    const response = await runBridgeRequest({
      request: makeUploadRequest({
        bridgeToken,
        uploadMetadata: {
          ...uploadMetadata,
          displayPath: "./large.zip",
        },
        chunks: [Buffer.from("payload")],
      }),
      activeRun: makeActiveRun(async (_payload: MessageCreateOptions) => {
        sendCalls += 1;
        throw discordApiError;
      }),
      loggedErrors,
    });

    expect(sendCalls).toBe(1);
    expect(response).toEqual(discordUploadFailure);
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toMatchObject({
      message: "tool bridge request failed",
      context: {
        pathname: "/tool/send-file",
        operation: "file upload",
        kind: "discord-api",
        error:
          "Discord rejected file upload (status 400, code 50035): Invalid Form Body\nfiles[0]: This file cannot be sent",
      },
    });
    expect(loggedErrors[0]?.context).toEqual(
      expect.objectContaining({
        cause: expect.stringContaining("DiscordAPIError[50035]"),
      }),
    );
  });

  test("classifies local upload failures as bridge-internal with the resolved route operation", async () => {
    const loggedErrors: Array<Record<string, unknown>> = [];

    const response = await runBridgeRequest({
      request: makeUploadRequest({
        bridgeToken,
        uploadMetadata,
        chunks: [Buffer.from("payload")],
      }),
      activeRun: makeActiveRun(() => Promise.reject(new Error("socket closed before response"))),
      loggedErrors,
    });

    expect(response).toEqual({
      status: 500,
      body: {
        error: "Discord bridge failed while performing file upload: socket closed before response",
        kind: "bridge-internal",
      },
    });
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toMatchObject({
      message: "tool bridge request failed",
      context: {
        pathname: "/tool/send-file",
        operation: "file upload",
        kind: "bridge-internal",
        error: "Discord bridge failed while performing file upload: socket closed before response",
      },
    });
  });

  test("returns the upload failure before the client finishes sending the HTTP request body", async () => {
    const request = new IncomingMessage(new Socket());
    request.method = "POST";
    request.headers = {
      "content-type": "application/octet-stream",
      "x-opencode-discord-token": bridgeToken,
      [uploadMetadataHeader]: Buffer.from(JSON.stringify(uploadMetadata), "utf8").toString(
        "base64url",
      ),
    };

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* handleToolBridgeRequest({
          request,
          pathname: uploadPath,
          config: makeConfig(bridgeToken),
          sessions: makeSessions(makeActiveRun(() => Promise.reject(makeDiscordApiError()))),
          logger: makeLogger([]),
        }).pipe(Effect.forkChild);

        request.push(Buffer.from("chunk-1"));

        return yield* Fiber.join(fiber).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            onTimeout: () =>
              Effect.fail(
                new Error("server did not respond before the client finished the request body"),
              ),
          }),
        );
      }),
    );

    expect(response).toEqual(discordUploadFailure);
    expect(request.isPaused()).toBe(true);
  });

  test("stops advancing the request iterator after an early Discord rejection", async () => {
    const discordApiError = makeDiscordApiError();
    let nextCalls = 0;

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const secondChunkRequested = yield* Deferred.make<void>();
        const fiber = yield* handleToolBridgeRequest({
          request: makeUploadRequest({
            bridgeToken,
            uploadMetadata,
            requestFactory: () => ({
              next: async () => {
                nextCalls += 1;
                if (nextCalls === 1) {
                  return {
                    done: false,
                    value: Buffer.from("chunk-1"),
                  };
                }

                await Effect.runPromise(
                  Deferred.succeed(secondChunkRequested, undefined).pipe(Effect.ignore),
                );
                return {
                  done: false,
                  value: Buffer.from("chunk-2"),
                };
              },
            }),
          }),
          pathname: uploadPath,
          config: makeConfig(bridgeToken),
          sessions: makeSessions(makeActiveRun(() => Promise.reject(discordApiError))),
          logger: makeLogger([]),
        }).pipe(Effect.forkChild);

        const result = yield* Fiber.join(fiber).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            onTimeout: () => Effect.fail(new Error("upload failure did not return promptly")),
          }),
        );

        expect(nextCalls).toBe(1);
        expect(Option.isNone(yield* Deferred.poll(secondChunkRequested))).toBe(true);
        return result;
      }),
    );

    expect(response).toEqual(discordUploadFailure);
  });

  test("returns a bridge failure when the request stream aborts before Discord finishes consuming the upload", async () => {
    let nextCalls = 0;

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* handleToolBridgeRequest({
          request: makeUploadRequest({
            bridgeToken,
            uploadMetadata,
            requestFactory: () => ({
              next: async () => {
                nextCalls += 1;
                if (nextCalls === 1) {
                  return {
                    done: false,
                    value: Buffer.from("chunk-1"),
                  };
                }

                throw new Error("request stream failed");
              },
            }),
          }),
          pathname: uploadPath,
          config: makeConfig(bridgeToken),
          sessions: makeSessions(
            makeActiveRun(async (payload: MessageCreateOptions) => {
              const attachment = (
                payload.files?.[0] as { attachment?: NodeJS.ReadableStream } | undefined
              )?.attachment;
              if (!attachment) {
                throw new Error("missing attachment stream");
              }

              await new Promise<void>((resolve, reject) => {
                attachment.once("end", resolve);
                attachment.once("error", reject);
                attachment.resume?.();
              });
            }),
          ),
          logger: makeLogger([]),
        }).pipe(Effect.forkChild);

        return yield* Fiber.join(fiber).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            onTimeout: () =>
              Effect.fail(new Error("request stream failure did not return promptly")),
          }),
        );
      }),
    );

    expect(nextCalls).toBe(2);
    expect(response).toEqual({
      status: 500,
      body: {
        error: "Discord bridge failed while performing file upload: request stream failed",
        kind: "bridge-internal",
      },
    });
  });

  test("returns a bridge failure when Discord closes a backpressured attachment stream", async () => {
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* handleToolBridgeRequest({
          request: makeUploadRequest({
            bridgeToken,
            uploadMetadata,
            chunks: [Buffer.alloc(1024 * 1024, 1)],
          }),
          pathname: uploadPath,
          config: makeConfig(bridgeToken),
          sessions: makeSessions(
            makeActiveRun(async (payload: MessageCreateOptions) => {
              const attachment = (
                payload.files?.[0] as
                  | {
                      attachment?: NodeJS.ReadableStream & {
                        destroy: () => void;
                        writableNeedDrain?: boolean;
                      };
                    }
                  | undefined
              )?.attachment;
              if (!attachment) {
                throw new Error("missing attachment stream");
              }

              await new Promise<void>((resolve, reject) => {
                const started = Date.now();
                const poll = () => {
                  if (attachment.writableNeedDrain) {
                    attachment.destroy();
                    resolve();
                    return;
                  }

                  if (Date.now() - started > 500) {
                    reject(new Error("attachment stream never entered backpressure"));
                    return;
                  }

                  setTimeout(poll, 1);
                };

                poll();
              });
            }),
          ),
          logger: makeLogger([]),
        }).pipe(Effect.forkChild);

        return yield* Fiber.join(fiber).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            onTimeout: () =>
              Effect.fail(
                new Error("destroyed backpressured attachment stream did not return promptly"),
              ),
          }),
        );
      }),
    );

    expect(response).toEqual({
      status: 500,
      body: {
        error:
          "Discord bridge failed while performing file upload: writable closed before the pending write completed",
        kind: "bridge-internal",
      },
    });
  });
});

describe("runToolBridgeHttpRequest", () => {
  test("logs and resolves when serializing the HTTP response throws", async () => {
    const loggedErrors: Array<Record<string, unknown>> = [];
    const response = unsafeStub<ServerResponse>({
      writeHead: () => {
        throw new Error("socket already closed");
      },
    });

    await expect(
      Effect.runPromise(
        runToolBridgeHttpRequest({
          request: makeUploadRequest({
            bridgeToken,
            uploadMetadata,
          }),
          response,
          pathname: uploadPath,
          config: makeConfig(bridgeToken),
          sessions: makeSessions(null),
          logger: makeLogger(loggedErrors),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toMatchObject({
      message: "tool bridge response failed",
      context: {
        pathname: "/tool/send-file",
      },
    });
    expect(loggedErrors[0]?.context).toEqual(
      expect.objectContaining({
        cause: expect.stringContaining("socket already closed"),
      }),
    );
  });
});
