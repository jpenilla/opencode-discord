import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Cause, Effect, FileSystem, Layer, Path, Redacted } from "effect";

import { AppConfig, type AppConfigShape } from "@/config.ts";
import { SessionRuntime, type SessionRuntimeShape } from "@/sessions/session-runtime.ts";
import { ToolBridgeResponseError, classifyToolBridgeFailure } from "@/tools/bridge/errors.ts";
import { matchToolBridgeRoute } from "@/tools/bridge/routes.ts";
import { sendJson } from "@/tools/bridge/transport.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";

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
  sessions: Pick<SessionRuntimeShape, "getActiveRunBySessionId">;
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
    Effect.catchCause((cause) => {
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

export const runToolBridgeHttpRequest = (input: {
  request: IncomingMessage;
  response: ServerResponse;
  pathname: string;
  config: AppConfigShape;
  sessions: Pick<SessionRuntimeShape, "getActiveRunBySessionId">;
  logger: LoggerShape;
}) =>
  handleToolBridgeRequest(input).pipe(
    Effect.flatMap(({ status, body }) => Effect.sync(() => sendJson(input.response, body, status))),
    Effect.catchCause((cause) =>
      input.logger
        .error("tool bridge response failed", {
          pathname: input.pathname,
          cause: Cause.pretty(cause),
        })
        .pipe(Effect.orElseSucceed(() => undefined)),
    ),
  );

const listenServer = (server: ReturnType<typeof createServer>, socketPath: string) =>
  Effect.callback<void, Error>((resume) => {
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
  Effect.callback<void, Error>((resume) => {
    server.close((error) => {
      if (error) {
        resume(Effect.fail(error));
        return;
      }
      resume(Effect.void);
    });
  });

export const ToolBridgeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const fs = yield* FileSystem.FileSystem;
    const logger = yield* Logger;
    const path = yield* Path.Path;
    const sessions = yield* SessionRuntime;

    yield* fs.makeDirectory(path.dirname(config.toolBridgeSocketPath), { recursive: true });
    yield* fs.remove(config.toolBridgeSocketPath, { force: true });

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((request, response) => {
          const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
          Effect.runFork(
            runToolBridgeHttpRequest({
              request,
              response,
              pathname,
              config,
              sessions,
              logger,
            }),
          );
        }),
      ).pipe(Effect.tap((server) => listenServer(server, config.toolBridgeSocketPath))),
      (server) =>
        Effect.all(
          [
            closeServer(server).pipe(Effect.ignore),
            fs.remove(config.toolBridgeSocketPath, { force: true }).pipe(Effect.ignore),
          ],
          { discard: true },
        ),
    );

    yield* logger.info("started tool bridge", {
      socketPath: config.toolBridgeSocketPath,
    });
  }),
);
