import { DiscordAPIError } from "discord.js";
import { Data } from "effect";

import { formatError } from "@/util/errors.ts";

export type ToolBridgeFailureKind = "discord-api" | "bridge-internal";

export type ToolBridgeFailure = {
  kind: ToolBridgeFailureKind;
  status: number;
  error: string;
};

export class ToolBridgeResponseError extends Data.TaggedError("ToolBridgeResponseError")<{
  readonly status: number;
  readonly message: string;
}> {}

export class ToolBridgeInternalError extends Data.TaggedError("ToolBridgeInternalError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ToolBridgeDiscordApiError extends Data.TaggedError("ToolBridgeDiscordApiError")<{
  readonly message: string;
  readonly status: number;
  readonly code: string | number;
  readonly cause: DiscordAPIError;
}> {}

const formatBoundaryMessage = (cause: unknown, fallbackMessage: string) => {
  if (cause === undefined) {
    return fallbackMessage;
  }

  const message = formatError(cause);
  return message.length > 0 ? message : fallbackMessage;
};

export const toolBridgeInternalError = (message: string, cause?: unknown) =>
  new ToolBridgeInternalError({ message, cause });

export const toolBridgeInternalBoundaryError = (message: string, cause: unknown) => {
  return cause instanceof ToolBridgeInternalError
    ? cause
    : toolBridgeInternalError(formatBoundaryMessage(cause, message), cause);
};

export const classifyToolBridgeFailure = (operation: string, error: unknown): ToolBridgeFailure => {
  const bridgeError =
    error instanceof ToolBridgeDiscordApiError || error instanceof ToolBridgeInternalError
      ? error
      : error instanceof DiscordAPIError
        ? new ToolBridgeDiscordApiError({
            message: error.message,
            status: error.status,
            code: error.code,
            cause: error,
          })
        : toolBridgeInternalError(formatError(error), error);

  if (bridgeError instanceof ToolBridgeDiscordApiError) {
    const details = [
      `status ${bridgeError.status}`,
      bridgeError.code !== undefined ? `code ${bridgeError.code}` : null,
    ].filter(Boolean);
    return {
      kind: "discord-api",
      status: 502,
      error: `Discord rejected ${operation}${details.length > 0 ? ` (${details.join(", ")})` : ""}: ${bridgeError.message}`,
    };
  }

  return {
    kind: "bridge-internal",
    status: 500,
    error: `Discord bridge failed while performing ${operation}: ${bridgeError.message}`,
  };
};
