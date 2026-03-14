import { Effect } from "effect";
import * as v from "valibot";

import { ToolBridgeResponseError } from "@/tools/bridge/errors.ts";

export const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const sessionPayloadSchema = v.looseObject({
  sessionID: nonEmptyString,
});

export type SessionPayload = v.InferOutput<typeof sessionPayloadSchema>;

export const parseBridgePayload = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  body: unknown,
  error: string,
) => {
  const result = v.safeParse(schema, body);
  return result.success
    ? Effect.succeed(result.output)
    : Effect.fail(new ToolBridgeResponseError(400, error));
};

export const parseSessionPayload = (body: unknown) => {
  return parseBridgePayload(sessionPayloadSchema, body, "missing sessionID");
};
