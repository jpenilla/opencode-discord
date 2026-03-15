import { createReadStream } from "node:fs";
import { request, type ClientRequest, type IncomingMessage } from "node:http";

import { Cause, Effect, Exit, Fiber, Stream } from "effect";

import { bridgeUploadHeaderName, encodeBridgeUploadMetadata, type BridgeUpload } from "./upload.ts";

const bridgeSocketPath = process.env.OPENCODE_DISCORD_BRIDGE_SOCKET;
const bridgeToken = process.env.OPENCODE_DISCORD_BRIDGE_TOKEN;

const ensureBridgeConfig = () => {
  if (!bridgeSocketPath || !bridgeToken) {
    throw new Error("Missing OPENCODE_DISCORD_BRIDGE_SOCKET or OPENCODE_DISCORD_BRIDGE_TOKEN");
  }

  return {
    bridgeSocketPath,
    bridgeToken,
  };
};

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const abortRequest = (req: ClientRequest) => {
  if (!req.destroyed) {
    req.abort();
  }
};

const stopBridgeUpload = (
  req: ClientRequest,
  file: { destroy: (error?: Error) => void },
  error?: unknown,
) =>
  Effect.sync(() => {
    const cause = error === undefined ? undefined : asError(error);
    file.destroy(cause);
    if (cause) {
      req.destroy(cause);
      return;
    }

    abortRequest(req);
  });

const waitForBridgeResponse = (req: ClientRequest) => {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onResponse = (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: string | Buffer) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      res.on("end", () => {
        cleanup();
        resolve({
          statusCode: res.statusCode ?? 500,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", onError);
    };

    const cleanup = () => {
      req.off("error", onError);
      req.off("response", onResponse);
    };

    req.once("error", onError);
    req.once("response", onResponse);
  });
};

const waitForBridgeResponseEffect = (req: ClientRequest) =>
  Effect.tryPromise({
    try: () => waitForBridgeResponse(req),
    catch: asError,
  });

const writeChunk = (req: ClientRequest, chunk: Uint8Array) =>
  Effect.async<void, Error>((resume) => {
    const onError = (error: Error) => {
      cleanup();
      resume(Effect.fail(error));
    };

    const onDrain = () => {
      cleanup();
      resume(Effect.void);
    };

    const cleanup = () => {
      req.off("error", onError);
      req.off("drain", onDrain);
    };

    req.once("error", onError);
    try {
      if (req.write(chunk)) {
        cleanup();
        resume(Effect.void);
        return Effect.void;
      }

      req.once("drain", onDrain);
      return Effect.sync(cleanup);
    } catch (error) {
      cleanup();
      resume(Effect.fail(asError(error)));
      return Effect.void;
    }
  });

const endRequest = (req: ClientRequest) =>
  Effect.async<void, Error>((resume) => {
    const onError = (error: Error) => {
      cleanup();
      resume(Effect.fail(error));
    };

    const cleanup = () => {
      req.off("error", onError);
    };

    req.once("error", onError);
    try {
      req.end(() => {
        cleanup();
        resume(Effect.void);
      });
      return Effect.sync(cleanup);
    } catch (error) {
      cleanup();
      resume(Effect.fail(asError(error)));
      return Effect.void;
    }
  });

const streamReadableToRequest = (
  readable: AsyncIterable<string | Uint8Array>,
  req: ClientRequest,
) => {
  return Stream.fromAsyncIterable(readable, asError).pipe(
    Stream.runForEach((chunk) =>
      writeChunk(req, typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    ),
    Effect.tap(() => endRequest(req)),
  );
};

export const raceBridgeUploadWithResponse = <A>(
  upload: Effect.Effect<void, Error>,
  response: Effect.Effect<A, Error>,
) =>
  Effect.raceWith(upload, response, {
    onSelfDone: (exit, responseFiber) =>
      Exit.matchEffect(exit, {
        onFailure: (cause) =>
          Fiber.interrupt(responseFiber).pipe(Effect.zipRight(Effect.failCause(cause))),
        onSuccess: () => Fiber.join(responseFiber),
      }),
    onOtherDone: (exit, uploadFiber) =>
      Exit.matchEffect(exit, {
        onFailure: (cause) =>
          Fiber.interrupt(uploadFiber).pipe(Effect.zipRight(Effect.failCause(cause))),
        onSuccess: (value) => Fiber.interrupt(uploadFiber).pipe(Effect.as(value)),
      }),
  });

const parseBridgeResponse = <T>(response: { statusCode: number; body: string }) => {
  const data =
    response.body.length > 0
      ? (JSON.parse(response.body) as { error?: string } & T)
      : ({} as T & { error?: string });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(data.error ?? `Bridge request failed with status ${response.statusCode}`);
  }

  return data;
};

const bridgeRequest = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
  const { bridgeSocketPath, bridgeToken } = ensureBridgeConfig();

  const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        socketPath: bridgeSocketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-discord-token": bridgeToken,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: string | Buffer) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("error", reject);
    req.end(JSON.stringify(body));
  });

  return parseBridgeResponse<T>(response);
};

export const sendBridgeRequest = async (path: string, body: Record<string, unknown>) => {
  const data = await bridgeRequest<{ message?: string }>(path, body);
  return data.message ?? "ok";
};

export const sendBridgeUpload = async (path: string, upload: BridgeUpload) => {
  const { bridgeSocketPath, bridgeToken } = ensureBridgeConfig();
  const file = createReadStream(upload.resolvedPath);
  const req = request({
    socketPath: bridgeSocketPath,
    path,
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-opencode-discord-token": bridgeToken,
      [bridgeUploadHeaderName]: encodeBridgeUploadMetadata(upload.metadata),
    },
  });
  const uploadEffect = streamReadableToRequest(file, req).pipe(
    Effect.onInterrupt(() => stopBridgeUpload(req, file)),
    Effect.onError((cause) => stopBridgeUpload(req, file, Cause.squash(cause))),
  );
  const responseEffect = waitForBridgeResponseEffect(req).pipe(
    Effect.flatMap((response) =>
      Effect.try({
        try: () => parseBridgeResponse<{ message?: string }>(response),
        catch: asError,
      }),
    ),
  );

  const data = await Effect.runPromise(raceBridgeUploadWithResponse(uploadEffect, responseEffect));
  return data.message ?? "ok";
};
