import { Data, Effect } from "effect";

import { formatError } from "@/util/errors.ts";

const formatRequestDetail = (detail: unknown) => {
  if (detail === undefined || detail === null || detail === "") {
    return "unexpected empty response";
  }
  if (typeof detail === "string") {
    return detail;
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return formatError(detail);
  }
};

export class OpencodeRequestError extends Data.TaggedError("OpencodeRequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type RequestResult<T> = {
  data?: T | null;
  error?: unknown;
};

export const requestError = (message: string, detail: unknown) =>
  new OpencodeRequestError({
    message: `${message}: ${formatRequestDetail(detail)}`,
    cause: detail,
  });

export const requestData = <T>(
  message: string,
  request: () => Promise<RequestResult<T>>,
): Effect.Effect<NonNullable<T>, OpencodeRequestError> =>
  Effect.tryPromise({
    try: request,
    catch: (error) => requestError(message, error),
  }).pipe(
    Effect.flatMap((result) => {
      const data = result.data;
      return result.error || data == null
        ? Effect.fail(requestError(message, result.error ?? result.data))
        : Effect.succeed(data as NonNullable<T>);
    }),
  );

export const requestTrue = (
  message: string,
  request: () => Promise<RequestResult<boolean>>,
): Effect.Effect<void, OpencodeRequestError> =>
  Effect.tryPromise({
    try: request,
    catch: (error) => requestError(message, error),
  }).pipe(
    Effect.flatMap((result) =>
      result.error || result.data !== true
        ? Effect.fail(requestError(message, result.error ?? result.data))
        : Effect.void,
    ),
  );

export const requestOk = (
  message: string,
  request: () => Promise<{ error?: unknown }>,
): Effect.Effect<void, OpencodeRequestError> =>
  Effect.tryPromise({
    try: request,
    catch: (error) => requestError(message, error),
  }).pipe(
    Effect.flatMap(({ error }) =>
      error ? Effect.fail(requestError(message, error)) : Effect.void,
    ),
  );
