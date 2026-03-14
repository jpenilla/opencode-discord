import type { IncomingMessage, ServerResponse } from "node:http";

import { Effect } from "effect";

import { ToolBridgeResponseError } from "@/tools/bridge/errors.ts";

export const sendJson = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const readBodyChunks = async (request: IncomingMessage) => {
  const bodyChunks: Uint8Array[] = [];
  for await (const chunk of request) {
    bodyChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return bodyChunks;
};

export const readJsonBody = (request: IncomingMessage) => {
  return Effect.tryPromise({
    try: () => readBodyChunks(request),
    catch: () => new ToolBridgeResponseError(400, "invalid json"),
  }).pipe(
    Effect.flatMap((chunks) => {
      if (chunks.length === 0) {
        return Effect.succeed(undefined);
      }

      const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
      return Effect.try({
        try: () => JSON.parse(raw),
        catch: () => new ToolBridgeResponseError(400, "invalid json"),
      });
    }),
  );
};
