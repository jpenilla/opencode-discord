import { describe, expect, test } from "bun:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessageCreateOptions, SendableChannels } from "discord.js";
import { Deferred, Effect, Fiber, Option, Redacted } from "effect";

import type { AppConfigShape } from "@/config.ts";
import type { ChannelSessionsShape } from "@/sessions/registry.ts";
import type { ActiveRun } from "@/sessions/session.ts";
import { uploadMetadataHeader } from "@/tools/bridge/handlers/uploads.ts";
import { handleToolBridgeRequest } from "@/tools/bridge/server.ts";
import type { LoggerShape } from "@/util/logging.ts";
import { unsafeStub } from "../../support/stub.ts";

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
}): IncomingMessage =>
  unsafeStub<IncomingMessage>({
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
    [Symbol.asyncIterator]:
      input.requestFactory ??
      async function* () {
        for (const chunk of input.chunks ?? []) {
          yield chunk;
        }
      },
  });

const makeSessions = (activeRun: ActiveRun | null): ChannelSessionsShape => ({
  submit: () => Effect.void,
  getActiveRunBySessionId: (sessionId: string) =>
    Effect.succeed(sessionId === "session-1" ? activeRun : null),
  handleInteraction: () => Effect.succeed(false),
  shutdown: () => Effect.void,
});

const makeActiveRun = (send: (payload: MessageCreateOptions) => Promise<unknown>): ActiveRun =>
  unsafeStub<ActiveRun>({
    discordMessage: {
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

describe("handleToolBridgeRequest", () => {
  test("returns unauthorized when the bridge token is invalid", async () => {
    const response = await Effect.runPromise(
      handleToolBridgeRequest({
        request: makeUploadRequest({
          bridgeToken: "wrong-token",
          uploadMetadata: {
            sessionID: "session-1",
            filename: "large.zip",
          },
        }),
        pathname: "/tool/send-file",
        config: makeConfig("bridge-token"),
        sessions: makeSessions(null),
        logger: makeLogger([]),
      }),
    );

    expect(response).toEqual({
      status: 401,
      body: {
        error: "unauthorized",
      },
    });
  });

  test("returns not found for unknown routes", async () => {
    const response = await Effect.runPromise(
      handleToolBridgeRequest({
        request: makeUploadRequest({
          bridgeToken: "bridge-token",
          uploadMetadata: {
            sessionID: "session-1",
            filename: "large.zip",
          },
        }),
        pathname: "/tool/unknown",
        config: makeConfig("bridge-token"),
        sessions: makeSessions(null),
        logger: makeLogger([]),
      }),
    );

    expect(response).toEqual({
      status: 404,
      body: {
        error: "not found",
      },
    });
  });

  test("returns conflict when the session has no active run", async () => {
    const response = await Effect.runPromise(
      handleToolBridgeRequest({
        request: makeUploadRequest({
          bridgeToken: "bridge-token",
          uploadMetadata: {
            sessionID: "session-1",
            filename: "large.zip",
          },
        }),
        pathname: "/tool/send-file",
        config: makeConfig("bridge-token"),
        sessions: makeSessions(null),
        logger: makeLogger([]),
      }),
    );

    expect(response).toEqual({
      status: 409,
      body: {
        error: "no active run for session",
      },
    });
  });

  test("returns direct request validation failures without bridge classification", async () => {
    const loggedErrors: Array<Record<string, unknown>> = [];

    const response = await Effect.runPromise(
      handleToolBridgeRequest({
        request: makeUploadRequest({
          bridgeToken: "bridge-token",
        }),
        pathname: "/tool/send-file",
        config: makeConfig("bridge-token"),
        sessions: makeSessions(null),
        logger: makeLogger(loggedErrors),
      }),
    );

    expect(response).toEqual({
      status: 400,
      body: {
        error: "missing upload metadata",
      },
    });
    expect(loggedErrors).toHaveLength(0);
  });

  test("formats Discord API upload failures through the server error path", async () => {
    const bridgeToken = "bridge-token";
    const discordApiError = makeDiscordApiError();
    let sendCalls = 0;
    const loggedErrors: Array<Record<string, unknown>> = [];

    const response = await Effect.runPromise(
      handleToolBridgeRequest({
        request: makeUploadRequest({
          bridgeToken,
          uploadMetadata: {
            sessionID: "session-1",
            filename: "large.zip",
            displayPath: "./large.zip",
          },
          chunks: [Buffer.from("payload")],
        }),
        pathname: "/tool/send-file",
        config: makeConfig(bridgeToken),
        sessions: makeSessions(
          makeActiveRun(async (_payload: MessageCreateOptions) => {
            sendCalls += 1;
            throw discordApiError;
          }),
        ),
        logger: makeLogger(loggedErrors),
      }),
    );

    expect(sendCalls).toBe(1);
    expect(response).toEqual({
      status: 502,
      body: {
        error:
          "Discord rejected file upload (status 400, code 50035): Invalid Form Body\nfiles[0]: This file cannot be sent",
        kind: "discord-api",
      },
    });
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
    const bridgeToken = "bridge-token";
    const loggedErrors: Array<Record<string, unknown>> = [];

    const response = await Effect.runPromise(
      handleToolBridgeRequest({
        request: makeUploadRequest({
          bridgeToken,
          uploadMetadata: {
            sessionID: "session-1",
            filename: "large.zip",
          },
          chunks: [Buffer.from("payload")],
        }),
        pathname: "/tool/send-file",
        config: makeConfig(bridgeToken),
        sessions: makeSessions(
          makeActiveRun(() => Promise.reject(new Error("socket closed before response"))),
        ),
        logger: makeLogger(loggedErrors),
      }),
    );

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
    const bridgeToken = "bridge-token";
    const request = new IncomingMessage(new Socket());
    request.method = "POST";
    request.headers = {
      "content-type": "application/octet-stream",
      "x-opencode-discord-token": bridgeToken,
      [uploadMetadataHeader]: Buffer.from(
        JSON.stringify({
          sessionID: "session-1",
          filename: "large.zip",
        }),
        "utf8",
      ).toString("base64url"),
    };

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* handleToolBridgeRequest({
          request,
          pathname: "/tool/send-file",
          config: makeConfig(bridgeToken),
          sessions: makeSessions(makeActiveRun(() => Promise.reject(makeDiscordApiError()))),
          logger: makeLogger([]),
        }).pipe(Effect.fork);

        request.push(Buffer.from("chunk-1"));

        return yield* Fiber.join(fiber).pipe(
          Effect.timeoutFail({
            duration: "1 second",
            onTimeout: () =>
              new Error("server did not respond before the client finished the request body"),
          }),
        );
      }),
    );

    expect(response).toEqual({
      status: 502,
      body: {
        error:
          "Discord rejected file upload (status 400, code 50035): Invalid Form Body\nfiles[0]: This file cannot be sent",
        kind: "discord-api",
      },
    });
    expect(request.complete).toBe(false);
    expect(request.isPaused()).toBe(true);
  });

  test("stops advancing the request iterator after an early Discord rejection", async () => {
    const bridgeToken = "bridge-token";
    const discordApiError = makeDiscordApiError();
    let nextCalls = 0;

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const secondChunkRequested = yield* Deferred.make<void>();
        const fiber = yield* handleToolBridgeRequest({
          request: makeUploadRequest({
            bridgeToken,
            uploadMetadata: {
              sessionID: "session-1",
              filename: "large.zip",
            },
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
          pathname: "/tool/send-file",
          config: makeConfig(bridgeToken),
          sessions: makeSessions(makeActiveRun(() => Promise.reject(discordApiError))),
          logger: makeLogger([]),
        }).pipe(Effect.fork);

        const result = yield* Fiber.join(fiber).pipe(
          Effect.timeoutFail({
            duration: "1 second",
            onTimeout: () => new Error("upload failure did not return promptly"),
          }),
        );

        expect(nextCalls).toBe(1);
        expect(Option.isNone(yield* Deferred.poll(secondChunkRequested))).toBe(true);
        return result;
      }),
    );

    expect(response).toEqual({
      status: 502,
      body: {
        error:
          "Discord rejected file upload (status 400, code 50035): Invalid Form Body\nfiles[0]: This file cannot be sent",
        kind: "discord-api",
      },
    });
  });
});
