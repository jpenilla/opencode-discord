import { Effect, Schema } from "effect";

import { ToolBridgeResponseError } from "@/tools/bridge/errors.ts";
import { ParseOptions } from "effect/SchemaAST";

export const nonEmptyString = Schema.NonEmptyString;

export const sessionPayloadSchema = Schema.Struct({
  sessionID: nonEmptyString,
});

export type SessionPayload = Schema.Schema.Type<typeof sessionPayloadSchema>;

const bridgeParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const satisfies ParseOptions;

export const parseBridgePayload = <
  TSchema extends Schema.Top & {
    readonly DecodingServices: never;
  },
>(
  schema: TSchema,
  body: unknown,
): Effect.Effect<TSchema["Type"], ToolBridgeResponseError> =>
  Schema.decodeUnknownEffect(schema)(body, bridgeParseOptions).pipe(
    Effect.mapError((error) => {
      if (Schema.isSchemaError(error)) {
        return new ToolBridgeResponseError({
          status: 400,
          message: `invalid request\n${error.message}`,
        });
      }

      return new ToolBridgeResponseError({
        status: 400,
        message: "invalid request",
      });
    }),
  );

export const parseSessionPayload = (body: unknown) => {
  return parseBridgePayload(sessionPayloadSchema, body);
};

const parseJsonText = (
  raw: string,
  error: string,
): Effect.Effect<unknown, ToolBridgeResponseError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(raw),
    catch: () => new ToolBridgeResponseError({ status: 400, message: error }),
  });

const requireHeaderString = (
  value: string | string[] | undefined,
  error: string,
): Effect.Effect<string, ToolBridgeResponseError> => {
  if (typeof value === "string" && value.length > 0) {
    return Effect.succeed(value);
  }

  return Effect.fail(new ToolBridgeResponseError({ status: 400, message: error }));
};

export const parseEncodedBridgePayload = <
  TSchema extends Schema.Top & {
    readonly DecodingServices: never;
  },
>(
  schema: TSchema,
  encoded: string | string[] | undefined,
  options: {
    missingError: string;
    invalidError: string;
  },
): Effect.Effect<TSchema["Type"], ToolBridgeResponseError> =>
  Effect.gen(function* () {
    const value = yield* requireHeaderString(encoded, options.missingError);
    const body = yield* parseJsonText(
      Buffer.from(value, "base64url").toString("utf8"),
      options.invalidError,
    );
    return yield* parseBridgePayload(schema, body);
  });
