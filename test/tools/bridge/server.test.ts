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
import {
  discordApiValidationMessage,
  makeDiscordApiError,
} from "../../support/discord-api-error.ts";
import { timeoutTestError } from "../../support/errors.ts";
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
    error: `Discord rejected file upload (status 400, code 50035): ${discordApiValidationMessage}`,
    kind: "discord-api",
  },
} as const;
const makeUploadMetadataHeader = (value: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const bridgeInternalFailure = (message: string) => ({
  status: 500,
  body: {
    error: `Discord bridge failed while performing file upload: ${message}`,
    kind: "bridge-internal",
  },
});

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
            [uploadMetadataHeader]: makeUploadMetadataHeader(input.uploadMetadata),
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

const makeDefaultUploadRequest = (
  input: Omit<Parameters<typeof makeUploadRequest>[0], "bridgeToken" | "uploadMetadata"> & {
    uploadMetadata?: Record<string, unknown>;
  } = {},
) =>
  makeUploadRequest({
    bridgeToken,
    uploadMetadata: input.uploadMetadata ?? uploadMetadata,
    chunks: input.chunks,
    requestFactory: input.requestFactory,
  });

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

const makeHandlerInput = (input: {
  request?: IncomingMessage;
  pathname?: string;
  activeRun?: ActiveRun | null;
  loggedErrors?: Array<Record<string, unknown>>;
  configBridgeToken?: string;
}) => {
  const configBridgeToken = input.configBridgeToken ?? bridgeToken;
  return {
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
  } as const;
};

type BridgeRequestInput = Parameters<typeof makeHandlerInput>[0];

const runBridgeRequest = (input: BridgeRequestInput = {}) => {
  return Effect.runPromise(handleToolBridgeRequest(makeHandlerInput(input)));
};

const runLoggedBridgeRequest = async (input: BridgeRequestInput = {}) => {
  const loggedErrors: Array<Record<string, unknown>> = [];
  return { response: await runBridgeRequest({ ...input, loggedErrors }), loggedErrors };
};

const expectPromptResponse = <A, E>(effect: Effect.Effect<A, E>, onTimeout: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* effect.pipe(Effect.forkChild);
      return yield* Fiber.join(fiber).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          onTimeout: () => Effect.fail(timeoutTestError(onTimeout)),
        }),
      );
    }),
  );

const runPromptBridgeRequest = (input: BridgeRequestInput, onTimeout: string) =>
  expectPromptResponse(handleToolBridgeRequest(makeHandlerInput(input)), onTimeout);

const expectBridgeRequestErrorLog = (
  loggedErrors: Array<Record<string, unknown>>,
  input: {
    kind: string;
    error: string;
    cause?: string;
  },
) => {
  expect(loggedErrors).toHaveLength(1);
  expect(loggedErrors[0]).toMatchObject({
    message: "tool bridge request failed",
    context: {
      pathname: uploadPath,
      operation: "file upload",
      kind: input.kind,
      error: input.error,
    },
  });
  if (input.cause) {
    expect(loggedErrors[0]?.context).toEqual(
      expect.objectContaining({
        cause: expect.stringContaining(input.cause),
      }),
    );
  }
};

describe("handleToolBridgeRequest", () => {
  for (const scenario of [
    {
      name: "returns unauthorized when the bridge token is invalid",
      input: {
        request: makeUploadRequest({ bridgeToken: "wrong-token", uploadMetadata }),
      },
      expected: { status: 401, body: { error: "unauthorized" } },
    },
    {
      name: "returns not found for unknown routes",
      input: { pathname: "/tool/unknown" },
      expected: { status: 404, body: { error: "not found" } },
    },
    {
      name: "returns conflict when the session has no active run",
      input: {},
      expected: { status: 409, body: { error: "no active run for session" } },
    },
    {
      name: "returns direct request validation failures without bridge classification",
      input: {
        request: makeUploadRequest({ bridgeToken }),
      },
      expected: { status: 400, body: { error: "missing upload metadata" } },
    },
  ]) {
    test(scenario.name, async () => {
      const { response, loggedErrors } = await runLoggedBridgeRequest(scenario.input);
      expect(response).toEqual(scenario.expected);
      expect(loggedErrors).toHaveLength(0);
    });
  }

  for (const scenario of [
    {
      name: "formats Discord API upload failures through the server error path",
      request: makeDefaultUploadRequest({
        uploadMetadata: {
          ...uploadMetadata,
          displayPath: "./large.zip",
        },
        chunks: [Buffer.from("payload")],
      }),
      send: async (_payload: MessageCreateOptions) => Promise.reject(makeDiscordApiError()),
      expectedResponse: discordUploadFailure,
      expectedKind: "discord-api",
      expectedError: `Discord rejected file upload (status 400, code 50035): ${discordApiValidationMessage}`,
      expectedCause: "DiscordAPIError[50035]",
    },
    {
      name: "classifies local upload failures as bridge-internal with the resolved route operation",
      request: makeDefaultUploadRequest({ chunks: [Buffer.from("payload")] }),
      send: async (_payload: MessageCreateOptions) =>
        Promise.reject(new Error("socket closed before response")),
      expectedResponse: bridgeInternalFailure("socket closed before response"),
      expectedKind: "bridge-internal",
      expectedError:
        "Discord bridge failed while performing file upload: socket closed before response",
    },
  ]) {
    test(scenario.name, async () => {
      let sendCalls = 0;
      const { response, loggedErrors } = await runLoggedBridgeRequest({
        request: scenario.request,
        activeRun: makeActiveRun(async (payload) => {
          sendCalls += 1;
          return scenario.send(payload);
        }),
      });

      expect(sendCalls).toBe(1);
      expect(response).toEqual(scenario.expectedResponse);
      expectBridgeRequestErrorLog(loggedErrors, {
        kind: scenario.expectedKind,
        error: scenario.expectedError,
        cause: scenario.expectedCause,
      });
    });
  }

  test("returns the upload failure before the client finishes sending the HTTP request body", async () => {
    const request = new IncomingMessage(new Socket());
    request.method = "POST";
    request.headers = {
      "content-type": "application/octet-stream",
      "x-opencode-discord-token": bridgeToken,
      [uploadMetadataHeader]: makeUploadMetadataHeader(uploadMetadata),
    };

    const response = await expectPromptResponse(
      Effect.gen(function* () {
        const fiber = yield* handleToolBridgeRequest(
          makeHandlerInput({
            request,
            activeRun: makeActiveRun(() => Promise.reject(makeDiscordApiError())),
          }),
        ).pipe(Effect.forkChild);

        request.push(Buffer.from("chunk-1"));
        return yield* Fiber.join(fiber);
      }),
      "server did not respond before the client finished the request body",
    );

    expect(response).toEqual(discordUploadFailure);
    expect(request.isPaused()).toBe(true);
  });

  test("stops advancing the request iterator after an early Discord rejection", async () => {
    const discordApiError = makeDiscordApiError();
    let nextCalls = 0;

    const response = await expectPromptResponse(
      Effect.gen(function* () {
        const secondChunkRequested = yield* Deferred.make<void>();
        const fiber = yield* handleToolBridgeRequest(
          makeHandlerInput({
            request: makeDefaultUploadRequest({
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
            activeRun: makeActiveRun(() => Promise.reject(discordApiError)),
          }),
        ).pipe(Effect.forkChild);

        const result = yield* Fiber.join(fiber);

        expect(nextCalls).toBe(1);
        expect(Option.isNone(yield* Deferred.poll(secondChunkRequested))).toBe(true);
        return result;
      }),
      "upload failure did not return promptly",
    );

    expect(response).toEqual(discordUploadFailure);
  });

  test("returns a bridge failure when the request stream aborts before Discord finishes consuming the upload", async () => {
    let nextCalls = 0;

    const response = await runPromptBridgeRequest(
      {
        request: makeDefaultUploadRequest({
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
        activeRun: makeActiveRun(async (payload: MessageCreateOptions) => {
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
      },
      "request stream failure did not return promptly",
    );

    expect(nextCalls).toBe(2);
    expect(response).toEqual(bridgeInternalFailure("request stream failed"));
  });

  test("returns a bridge failure when Discord closes a backpressured attachment stream", async () => {
    const response = await runPromptBridgeRequest(
      {
        request: makeDefaultUploadRequest({ chunks: [Buffer.alloc(1024 * 1024, 1)] }),
        activeRun: makeActiveRun(async (payload: MessageCreateOptions) => {
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
      },
      "destroyed backpressured attachment stream did not return promptly",
    );

    expect(response).toEqual(
      bridgeInternalFailure("writable closed before the pending write completed"),
    );
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
    const requestInput = makeHandlerInput({});

    const result = await Effect.runPromise(
      runToolBridgeHttpRequest({
        request: requestInput.request,
        response,
        pathname: requestInput.pathname,
        config: requestInput.config,
        sessions: requestInput.sessions,
        logger: makeLogger(loggedErrors),
      }),
    );

    expect(result).toBeUndefined();

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
