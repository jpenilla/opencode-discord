export type ToolBridgeFailureKind = "discord-api" | "bridge-internal";

export type ToolBridgeFailure = {
  kind: ToolBridgeFailureKind;
  status: number;
  error: string;
};

export class ToolBridgeResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const stringProp = (record: Record<string, unknown> | null, key: string): string | null =>
  typeof record?.[key] === "string" ? (record[key] as string) : null;

const numberProp = (record: Record<string, unknown> | null, key: string): number | null =>
  typeof record?.[key] === "number" ? (record[key] as number) : null;

// Bridge handlers preserve raw promise rejections at the boundary. This is only a fallback for
// wrapped failures that already crossed an Effect.tryPromise boundary elsewhere.
const unwrapEffectUnknownException = (error: unknown): unknown => {
  const record = asRecord(error);
  if (record?._tag !== "UnknownException") {
    return error;
  }

  return record.error ?? record.cause ?? error;
};

const formatErrorMessage = (error: unknown) => {
  const unwrapped = unwrapEffectUnknownException(error);
  const record = asRecord(unwrapped);
  const directMessage = stringProp(record, "message");
  if (directMessage) {
    return directMessage;
  }

  const rawError = asRecord(record?.rawError);
  const rawMessage = stringProp(rawError, "message");
  if (rawMessage) {
    return rawMessage;
  }

  if (unwrapped instanceof Error) {
    return unwrapped.message;
  }
  return String(unwrapped);
};

const isDiscordApiError = (error: unknown) => {
  const record = asRecord(unwrapEffectUnknownException(error));
  const name = stringProp(record, "name");
  return Boolean(
    (name && name.startsWith("DiscordAPIError")) ||
    (record && "rawError" in record && typeof record.status === "number"),
  );
};

export const classifyToolBridgeFailure = (operation: string, error: unknown): ToolBridgeFailure => {
  const unwrapped = unwrapEffectUnknownException(error);
  const record = asRecord(unwrapped);
  const message = formatErrorMessage(error);

  if (isDiscordApiError(unwrapped)) {
    const status = numberProp(record, "status");
    const code = record?.code;
    const details = [
      status !== null ? `status ${status}` : null,
      typeof code === "number" || typeof code === "string" ? `code ${code}` : null,
    ].filter(Boolean);

    return {
      kind: "discord-api",
      status: 502,
      error: `Discord rejected ${operation}${details.length > 0 ? ` (${details.join(", ")})` : ""}: ${message}`,
    };
  }

  return {
    kind: "bridge-internal",
    status: 500,
    error: `Discord bridge failed while performing ${operation}: ${message}`,
  };
};
