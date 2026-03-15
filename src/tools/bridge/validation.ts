import { Effect } from "effect";
import * as v from "valibot";

import { ToolBridgeResponseError } from "@/tools/bridge/errors.ts";

export const nonEmptyString = v.pipe(v.string(), v.minLength(1));
type ValidationIssue = Parameters<typeof v.getDotPath>[0];

export const sessionPayloadSchema = v.looseObject({
  sessionID: nonEmptyString,
});

export type SessionPayload = v.InferOutput<typeof sessionPayloadSchema>;

const formatValidationIssues = (issues: readonly ValidationIssue[]) => {
  const details = [
    ...new Set(
      issues.map((issue) => {
        const path = v.getDotPath(issue);
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    ),
  ];

  return details.length > 0 ? `invalid request: ${details.join("; ")}` : "invalid request";
};

export const parseBridgePayload = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  body: unknown,
) => {
  const result = v.safeParse(schema, body);
  return result.success
    ? Effect.succeed(result.output)
    : Effect.fail(new ToolBridgeResponseError(400, formatValidationIssues(result.issues)));
};

export const parseSessionPayload = (body: unknown) => {
  return parseBridgePayload(sessionPayloadSchema, body);
};

const parseJsonText = (
  raw: string,
  error: string,
): Effect.Effect<unknown, ToolBridgeResponseError> =>
  Effect.try({
    try: () => JSON.parse(raw),
    catch: () => new ToolBridgeResponseError(400, error),
  });

const requireHeaderString = (
  value: string | string[] | undefined,
  error: string,
): Effect.Effect<string, ToolBridgeResponseError> => {
  if (typeof value === "string" && value.length > 0) {
    return Effect.succeed(value);
  }

  return Effect.fail(new ToolBridgeResponseError(400, error));
};

export const parseEncodedBridgePayload = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  encoded: string | string[] | undefined,
  options: {
    missingError: string;
    invalidError: string;
  },
): Effect.Effect<v.InferOutput<TSchema>, ToolBridgeResponseError> =>
  Effect.gen(function* () {
    const value = yield* requireHeaderString(encoded, options.missingError);
    const body = yield* parseJsonText(
      Buffer.from(value, "base64url").toString("utf8"),
      options.invalidError,
    );
    return yield* parseBridgePayload(schema, body);
  });
