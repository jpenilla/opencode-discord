import { createReadStream } from "node:fs";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";

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
) => {
  const cause = error === undefined ? undefined : asError(error);
  file.destroy(cause);
  if (cause) {
    req.destroy(cause);
    return;
  }

  abortRequest(req);
};

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

export const formatBridgeMessage = (message: unknown) => {
  if (message === undefined) {
    return "ok";
  }

  return typeof message === "string" ? message : JSON.stringify(message, null, 2);
};

export const raceBridgeUploadWithResponse = async <A>(input: {
  upload: Promise<void>;
  response: Promise<A>;
  abortUpload: (error?: unknown) => void;
  abortResponse: (error?: unknown) => void;
}) => {
  let responseSettled = false;
  const responsePromise = input.response.then(
    (value) => {
      responseSettled = true;
      input.abortUpload();
      return value;
    },
    (error) => {
      responseSettled = true;
      input.abortUpload(error);
      throw asError(error);
    },
  );
  const uploadPromise = input.upload.then(
    () => responsePromise,
    (error) => {
      if (responseSettled) {
        return undefined as never;
      }

      input.abortResponse(error);
      throw asError(error);
    },
  );

  void responsePromise.catch(() => undefined);
  void uploadPromise.catch(() => undefined);

  return await Promise.race([responsePromise, uploadPromise]);
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
  const data = await bridgeRequest<{ message?: unknown }>(path, body);
  return formatBridgeMessage(data.message);
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
  const data = await raceBridgeUploadWithResponse({
    upload: pipeline(file, req),
    response: waitForBridgeResponse(req).then((response) =>
      parseBridgeResponse<{ message?: unknown }>(response),
    ),
    abortUpload: (error) => stopBridgeUpload(req, file, error),
    abortResponse: (error) => {
      if (!req.destroyed) {
        req.destroy(asError(error));
      }
    },
  });
  return formatBridgeMessage(data.message);
};
