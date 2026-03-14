import { Effect } from "effect";
import * as v from "valibot";

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
  messageRoutePayloadSchema,
  reactPayloadSchema,
} from "@/tools/bridge/handlers/messages.ts";
import {
  handleSendFile,
  handleSendImage,
  uploadPayloadSchema,
} from "@/tools/bridge/handlers/uploads.ts";
import { parseBridgePayload } from "@/tools/bridge/validation.ts";

type ToolBridgeRouteExecutionContext = {
  activeRun: ActiveRun;
  body: unknown;
};

export type ToolBridgeHandlerContext<TPayload> = {
  activeRun: ActiveRun;
  payload: TPayload;
};

export type ToolBridgeRoute = {
  method: "POST";
  pathname: string;
  operation: string;
  execute: (context: ToolBridgeRouteExecutionContext) => Effect.Effect<unknown, unknown>;
};

type ToolBridgeRouteConfig<TPayload> = {
  method: "POST";
  pathname: string;
  operation: string;
  parse: (body: unknown) => Effect.Effect<TPayload, unknown>;
  handle: (context: ToolBridgeHandlerContext<TPayload>) => Effect.Effect<unknown, unknown>;
};

const createRoute = <TPayload>(config: ToolBridgeRouteConfig<TPayload>): ToolBridgeRoute => {
  return {
    method: config.method,
    pathname: config.pathname,
    operation: config.operation,
    execute: ({ activeRun, body }) =>
      Effect.flatMap(config.parse(body), (payload) =>
        config.handle({
          activeRun,
          payload,
        }),
      ),
  };
};

const createSchemaRoute = <TSchema extends v.GenericSchema>(
  config: Omit<ToolBridgeRouteConfig<v.InferOutput<TSchema>>, "parse"> & {
    schema: TSchema;
    error: string;
  },
): ToolBridgeRoute => {
  return createRoute({
    method: config.method,
    pathname: config.pathname,
    operation: config.operation,
    parse: (body) => parseBridgePayload(config.schema, body, config.error),
    handle: config.handle,
  });
};

const noPayload = () => Effect.succeed(undefined);

const toolBridgeRoutes = [
  createSchemaRoute({
    method: "POST",
    pathname: "/tool/send-file",
    operation: "file upload",
    schema: uploadPayloadSchema,
    error: "missing upload data",
    handle: handleSendFile,
  }),
  createSchemaRoute({
    method: "POST",
    pathname: "/tool/send-image",
    operation: "image upload",
    schema: uploadPayloadSchema,
    error: "missing upload data",
    handle: handleSendImage,
  }),
  createRoute({
    method: "POST",
    pathname: "/tool/list-custom-emojis",
    operation: "custom emoji listing",
    parse: noPayload,
    handle: handleListCustomEmojis,
  }),
  createRoute({
    method: "POST",
    pathname: "/tool/list-stickers",
    operation: "sticker listing",
    parse: noPayload,
    handle: handleListStickers,
  }),
  createSchemaRoute({
    method: "POST",
    pathname: "/tool/send-sticker",
    operation: "sticker send",
    schema: sendStickerPayloadSchema,
    error: "missing stickerID",
    handle: handleSendSticker,
  }),
  createRoute({
    method: "POST",
    pathname: "/tool/react",
    operation: "reaction",
    parse: (body) =>
      parseBridgePayload(messageRoutePayloadSchema, body, "missing messageId").pipe(
        Effect.zipRight(parseBridgePayload(reactPayloadSchema, body, "missing emoji")),
      ),
    handle: handleReact,
  }),
  createSchemaRoute({
    method: "POST",
    pathname: "/tool/list-attachments",
    operation: "attachment listing",
    schema: listAttachmentsPayloadSchema,
    error: "missing messageId",
    handle: handleListAttachments,
  }),
] satisfies ToolBridgeRoute[];

export const matchToolBridgeRoute = (method: string | undefined, pathname: string) => {
  return (
    toolBridgeRoutes.find((route) => route.method === method && route.pathname === pathname) ?? null
  );
};
