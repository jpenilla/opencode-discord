import { createServer, type IncomingMessage } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { Cause, Context, Effect, Layer, Redacted } from "effect";

import { AppConfig, type AppConfigShape } from "@/config.ts";
import { ChannelSessions, type ChannelSessionsShape } from "@/sessions/registry.ts";
import { ToolBridgeResponseError, classifyToolBridgeFailure } from "@/tools/bridge/errors.ts";
import { matchToolBridgeRoute } from "@/tools/bridge/routes.ts";
import { sendJson } from "@/tools/bridge/transport.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";

export type ToolBridgeShape = {
  socketPath: string;
};

export class ToolBridge extends Context.Tag("ToolBridge")<ToolBridge, ToolBridgeShape>() {}

type ToolBridgeHttpResponse = {
  status: number;
  body: unknown;
};

const jsonResponse = (status: number, body: unknown): ToolBridgeHttpResponse => ({
  status,
  body,
});

export const handleToolBridgeRequest = (input: {
  request: IncomingMessage;
  pathname: string;
  config: AppConfigShape;
  sessions: ChannelSessionsShape;
  logger: LoggerShape;
}): Effect.Effect<ToolBridgeHttpResponse> => {
  if (
    input.request.headers["x-opencode-discord-token"] !==
    Redacted.value(input.config.toolBridgeToken)
  ) {
    return Effect.succeed(jsonResponse(401, { error: "unauthorized" }));
  }

  const route = matchToolBridgeRoute(input.request.method, input.pathname);
  if (!route) {
    return Effect.succeed(jsonResponse(404, { error: "not found" }));
  }

  return Effect.gen(function* () {
    const parsedRequest = yield* route.parseRequest(input.request);
    const activeRun = yield* input.sessions.getActiveRunBySessionId(parsedRequest.sessionID);
    if (!activeRun) {
      return jsonResponse(409, { error: "no active run for session" });
    }

    const message = yield* route.execute({
      activeRun,
      request: input.request,
      payload: parsedRequest.payload,
    });
    return jsonResponse(200, { ok: true, message });
  }).pipe(
    Effect.catchAllCause((cause) => {
      const squashedError = Cause.squash(cause);
      if (squashedError instanceof ToolBridgeResponseError) {
        return Effect.succeed(jsonResponse(squashedError.status, { error: squashedError.message }));
      }

      const failure = classifyToolBridgeFailure(route.operation, squashedError);
      return input.logger
        .error("tool bridge request failed", {
          pathname: input.pathname,
          operation: route.operation,
          kind: failure.kind,
          error: failure.error,
          cause: Cause.pretty(cause),
        })
        .pipe(
          Effect.as(
            jsonResponse(failure.status, {
              error: failure.error,
              kind: failure.kind,
            }),
          ),
        );
    }),
  );
};

const listenServer = (server: ReturnType<typeof createServer>, socketPath: string) =>
  Effect.async<void, Error>((resume) => {
    const onError = (error: Error) => {
      cleanup();
      resume(Effect.fail(error));
    };

    const onListening = () => {
      cleanup();
      resume(Effect.void);
    };

    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
    return Effect.sync(cleanup);
  });

const closeServer = (server: ReturnType<typeof createServer>) =>
  Effect.async<void, Error>((resume) => {
    server.close((error) => {
      if (error) {
        resume(Effect.fail(error));
        return;
      }
      resume(Effect.void);
    });
  });

export const ToolBridgeLive = Layer.scoped(
  ToolBridge,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const logger = yield* Logger;
    const sessions = yield* ChannelSessions;

    yield* Effect.promise(() => mkdir(dirname(config.toolBridgeSocketPath), { recursive: true }));
    yield* Effect.promise(() => rm(config.toolBridgeSocketPath, { force: true }));

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((request, response) => {
          const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
          void Effect.runPromise(
            handleToolBridgeRequest({
              request,
              pathname,
              config,
              sessions,
              logger,
            }).pipe(
              Effect.flatMap(({ status, body }) =>
                Effect.sync(() => sendJson(response, body, status)),
              ),
            ),
          );
        }),
      ).pipe(Effect.tap((server) => listenServer(server, config.toolBridgeSocketPath))),
      (server) =>
        Effect.all(
          [
            closeServer(server).pipe(Effect.ignore),
            Effect.promise(() => rm(config.toolBridgeSocketPath, { force: true })).pipe(
              Effect.ignore,
            ),
          ],
          { discard: true },
        ),
    );

    yield* logger.info("started tool bridge", {
      socketPath: config.toolBridgeSocketPath,
    });

    return {
      socketPath: config.toolBridgeSocketPath,
    } satisfies ToolBridgeShape;
  }),
);
