import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { Context, Effect, Layer, Redacted } from "effect";

import { AppConfig } from "@/config.ts";
import { ChannelSessions } from "@/sessions/registry.ts";
import { ToolBridgeResponseError, classifyToolBridgeFailure } from "@/tools/bridge/errors.ts";
import { matchToolBridgeRoute } from "@/tools/bridge/routes.ts";
import { readJsonBody, sendJson } from "@/tools/bridge/transport.ts";
import { parseSessionPayload } from "@/tools/bridge/validation.ts";
import { Logger } from "@/util/logging.ts";

export type ToolBridgeShape = {
  socketPath: string;
};

export class ToolBridge extends Context.Tag("ToolBridge")<ToolBridge, ToolBridgeShape>() {}

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
          let operation = "tool bridge request";

          const handleRequest = Effect.gen(function* () {
            if (
              request.headers["x-opencode-discord-token"] !== Redacted.value(config.toolBridgeToken)
            ) {
              yield* Effect.sync(() => sendJson(response, { error: "unauthorized" }, 401));
              return;
            }

            const body = yield* readJsonBody(request);
            const payload = yield* parseSessionPayload(body);
            const activeRun = yield* sessions.getActiveRunBySessionId(payload.sessionID);
            if (!activeRun) {
              yield* Effect.sync(() => sendJson(response, { error: "no active run for session" }, 409));
              return;
            }

            const route = matchToolBridgeRoute(request.method, pathname);
            if (!route) {
              yield* Effect.sync(() => sendJson(response, { error: "not found" }, 404));
              return;
            }

            operation = route.operation;
            const message = yield* route.execute({
              activeRun,
              body,
            });
            yield* Effect.sync(() => sendJson(response, { ok: true, message }));
          }).pipe(
            Effect.catchIf(
              (error): error is ToolBridgeResponseError => error instanceof ToolBridgeResponseError,
              (error) =>
                Effect.sync(() => sendJson(response, { error: error.message }, error.status)),
            ),
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const failure = classifyToolBridgeFailure(operation, error);
                yield* logger.error("tool bridge request failed", {
                  pathname,
                  operation,
                  kind: failure.kind,
                  error: failure.error,
                  cause: String(error),
                });
                yield* Effect.sync(() =>
                  sendJson(
                    response,
                    {
                      error: failure.error,
                      kind: failure.kind,
                    },
                    failure.status,
                  ),
                );
              }),
            ),
          );

          void Effect.runPromise(handleRequest);
        }),
      ).pipe(
        Effect.tap((server) => listenServer(server, config.toolBridgeSocketPath)),
      ),
      (server) =>
        Effect.all(
          [
            closeServer(server).pipe(Effect.ignore),
            Effect.promise(() => rm(config.toolBridgeSocketPath, { force: true })).pipe(Effect.ignore),
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
