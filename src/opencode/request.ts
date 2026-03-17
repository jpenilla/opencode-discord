import { Effect } from "effect";

const formatRequestDetail = (detail: unknown) => {
  if (detail === undefined || detail === null || detail === "") {
    return "unexpected empty response";
  }
  if (typeof detail === "string") {
    return detail;
  }
  if (detail instanceof Error) {
    return detail.stack ?? detail.message;
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
};

export type RequestResult<T> = {
  data?: T | null;
  error?: unknown;
};

export const requestError = (message: string, detail: unknown) =>
  new Error(`${message}: ${formatRequestDetail(detail)}`);

const requestResult = <TResult, TError>(
  request: () => Promise<TResult>,
  onReject: (error: unknown) => TError,
) =>
  Effect.tryPromise({
    try: request,
    catch: onReject,
  });

export const requestData = <T>(
  message: string,
  request: () => Promise<RequestResult<T>>,
): Effect.Effect<NonNullable<T>, Error> =>
  requestResult(request, (error) => requestError(message, error)).pipe(
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
): Effect.Effect<void, Error> =>
  requestResult(request, (error) => requestError(message, error)).pipe(
    Effect.flatMap((result) =>
      result.error || result.data !== true
        ? Effect.fail(requestError(message, result.error ?? result.data))
        : Effect.void,
    ),
  );

export const requestOk = (
  message: string,
  request: () => Promise<{ error?: unknown }>,
): Effect.Effect<void, Error> =>
  requestResult(request, (error) => requestError(message, error)).pipe(
    Effect.flatMap(({ error }) => (error ? Effect.fail(requestError(message, error)) : Effect.void)),
  );
