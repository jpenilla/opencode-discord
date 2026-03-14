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

const formatErrorMessage = (error: unknown) => {
  const record = asRecord(error);
  const directMessage = stringProp(record, "message");
  if (directMessage) {
    return directMessage;
  }

  const rawError = asRecord(record?.rawError);
  const rawMessage = stringProp(rawError, "message");
  if (rawMessage) {
    return rawMessage;
  }

  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const isDiscordApiError = (error: unknown) => {
  const record = asRecord(error);
  const name = stringProp(record, "name");
  return Boolean(
    (name && name.startsWith("DiscordAPIError")) ||
    (record && "rawError" in record && typeof record.status === "number"),
  );
};

export const classifyToolBridgeFailure = (operation: string, error: unknown): ToolBridgeFailure => {
  const record = asRecord(error);
  const message = formatErrorMessage(error);

  if (isDiscordApiError(error)) {
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
