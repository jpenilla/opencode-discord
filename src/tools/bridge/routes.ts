import type { IncomingMessage } from "node:http";

import { Effect, Schema } from "effect";

import type { ActiveRun } from "@/sessions/session.ts";
import {
  handleListCustomEmojis,
  handleListStickers,
  handleSendSticker,
  sendStickerPayloadSchema,
} from "@/tools/bridge/handlers/assets.ts";
import {
  handleListAttachments,
  handleReact,
  listAttachmentsPayloadSchema,
  reactPayloadSchema,
} from "@/tools/bridge/handlers/messages.ts";
import {
  handleSendFile,
  handleSendImage,
  parseUploadHeaders,
  type UploadPayload,
} from "@/tools/bridge/handlers/uploads.ts";
import { readJsonBody } from "@/tools/bridge/transport.ts";
import { parseBridgePayload, sessionPayloadSchema } from "@/tools/bridge/validation.ts";

type ParsedToolBridgeRequest<TPayload> = {
  sessionID: string;
  payload: TPayload;
};

export type ToolBridgeHandlerContext<TPayload> = {
  activeRun: ActiveRun;
  request: IncomingMessage;
  payload: TPayload;
};

type ToolBridgeRouteExecutionContext = ToolBridgeHandlerContext<unknown>;

export type ToolBridgeRoute = {
  method: "POST";
  pathname: string;
  operation: string;
  parseRequest: (
    request: IncomingMessage,
  ) => Effect.Effect<ParsedToolBridgeRequest<unknown>, unknown>;
  execute: (context: ToolBridgeRouteExecutionContext) => Effect.Effect<unknown, unknown>;
};

type ToolBridgeRouteConfig<TPayload> = {
  method: "POST";
  pathname: string;
  operation: string;
  parseRequest: (
    request: IncomingMessage,
  ) => Effect.Effect<ParsedToolBridgeRequest<TPayload>, unknown>;
  handle: (context: ToolBridgeHandlerContext<TPayload>) => Effect.Effect<unknown, unknown>;
};

const createRoute = <TPayload>(config: ToolBridgeRouteConfig<TPayload>): ToolBridgeRoute => {
  return {
    method: config.method,
    pathname: config.pathname,
    operation: config.operation,
    parseRequest: config.parseRequest as ToolBridgeRoute["parseRequest"],
    execute: ({ activeRun, request, payload }) =>
      config.handle({
        activeRun,
        request,
        payload: payload as TPayload,
      }),
  };
};

const parseJsonRequest = <TPayload>(
  request: IncomingMessage,
  parse: (body: unknown) => Effect.Effect<ParsedToolBridgeRequest<TPayload>, unknown>,
) =>
  Effect.gen(function* () {
    const body = yield* readJsonBody(request);
    return yield* parse(body);
  });

const withSessionPayloadSchema = <TSchema extends Schema.Struct<Schema.Struct.Fields>>(
  schema: TSchema,
) =>
  Schema.Struct({
    ...sessionPayloadSchema.fields,
    ...schema.fields,
  });

const splitSessionRequest = <TPayload extends { sessionID: string }>(request: TPayload) => {
  const { sessionID, ...payload } = request;
  return {
    sessionID,
    payload: payload as Omit<TPayload, "sessionID">,
  };
};

const createSchemaRoute = <TSchema extends Schema.Struct<Schema.Struct.Fields>>(
  config: Omit<ToolBridgeRouteConfig<Schema.Schema.Type<TSchema>>, "parseRequest"> & {
    schema: TSchema;
  },
): ToolBridgeRoute => {
  const requestSchema = withSessionPayloadSchema(config.schema);
  return createRoute({
    method: config.method,
    pathname: config.pathname,
    operation: config.operation,
    parseRequest: (request) =>
      parseJsonRequest(request, (body) =>
        parseBridgePayload(requestSchema, body).pipe(
          Effect.map(
            (parsed) =>
              splitSessionRequest(parsed) as ParsedToolBridgeRequest<Schema.Schema.Type<TSchema>>,
          ),
        ),
      ),
    handle: config.handle,
  });
};

const parseSessionRequest = (
  body: unknown,
): Effect.Effect<ParsedToolBridgeRequest<void>, unknown> =>
  parseBridgePayload(sessionPayloadSchema, body).pipe(
    Effect.map(({ sessionID }) => ({
      sessionID,
      payload: undefined as void,
    })),
  );

const parseUploadRequest = (
  request: IncomingMessage,
): Effect.Effect<ParsedToolBridgeRequest<UploadPayload>, unknown> =>
  Effect.gen(function* () {
    const payload = yield* parseUploadHeaders(request.headers);
    return {
      sessionID: payload.sessionID,
      payload,
    };
  });

const toolBridgeRoutes = [
  createRoute({
    method: "POST",
    pathname: "/tool/send-file",
    operation: "file upload",
    parseRequest: parseUploadRequest,
    handle: handleSendFile,
  }),
  createRoute({
    method: "POST",
    pathname: "/tool/send-image",
    operation: "image upload",
    parseRequest: parseUploadRequest,
    handle: handleSendImage,
  }),
  createRoute({
    method: "POST",
    pathname: "/tool/list-custom-emojis",
    operation: "custom emoji listing",
    parseRequest: (request) => parseJsonRequest(request, parseSessionRequest),
    handle: handleListCustomEmojis,
  }),
  createRoute({
    method: "POST",
    pathname: "/tool/list-stickers",
    operation: "sticker listing",
    parseRequest: (request) => parseJsonRequest(request, parseSessionRequest),
    handle: handleListStickers,
  }),
  createSchemaRoute({
    method: "POST",
    pathname: "/tool/send-sticker",
    operation: "sticker send",
    schema: sendStickerPayloadSchema,
    handle: handleSendSticker,
  }),
  createSchemaRoute({
    method: "POST",
    pathname: "/tool/react",
    operation: "reaction",
    schema: reactPayloadSchema,
    handle: handleReact,
  }),
  createSchemaRoute({
    method: "POST",
    pathname: "/tool/list-attachments",
    operation: "attachment listing",
    schema: listAttachmentsPayloadSchema,
    handle: handleListAttachments,
  }),
] satisfies ToolBridgeRoute[];

export const matchToolBridgeRoute = (method: string | undefined, pathname: string) => {
  return (
    toolBridgeRoutes.find((route) => route.method === method && route.pathname === pathname) ?? null
  );
};
