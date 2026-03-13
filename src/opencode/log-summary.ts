import type { GlobalEvent, PermissionRequest } from "@opencode-ai/sdk/v2";

const formatLogValue = (value: unknown) => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const truncateLogField = (value: string, maxLength = 200) =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;

const summarizeLogValueShape = (value: unknown) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return {
      kind: "text",
      chars: value.length,
    };
  }

  if (Array.isArray(value)) {
    return {
      kind: "array",
      items: value.length,
    };
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      kind: "object",
      fields: Object.keys(record).length,
      diffs: Array.isArray(record.diffs) ? record.diffs.length : undefined,
    };
  }

  return {
    kind: typeof value,
  };
};

export const summarizePermissionForLog = (permission: PermissionRequest) => {
  return {
    permission: permission.permission,
    patterns: permission.patterns.length,
    always: permission.always.length,
    metadata: summarizeLogValueShape(permission.metadata),
    toolCallId: permission.tool?.callID,
  };
};

export const summarizeOpencodeEventForLog = (event: GlobalEvent["payload"]) => {
  switch (event.type) {
    case "message.updated": {
      const info = event.properties.info;
      return {
        type: event.type,
        sessionId: info.sessionID,
        messageId: info.id,
        role: info.role,
        parentId: "parentID" in info ? info.parentID : undefined,
        mode: "mode" in info ? info.mode : undefined,
        summary: "summary" in info ? summarizeLogValueShape(info.summary) : undefined,
        completed: "completed" in info.time ? info.time.completed !== undefined : undefined,
        finish: "finish" in info ? info.finish : undefined,
        error:
          "error" in info && info.error
            ? truncateLogField(formatLogValue(info.error))
            : undefined,
      };
    }
    case "message.part.updated": {
      const part = event.properties.part;
      const base = {
        type: event.type,
        sessionId: part.sessionID,
        messageId: part.messageID,
        partId: part.id,
        partType: part.type,
      };

      if (part.type !== "tool") {
        return base;
      }

      return {
        ...base,
        callId: part.callID,
        tool: part.tool,
        status: part.state.status,
        title:
          (part.state.status === "running" || part.state.status === "completed") &&
          typeof part.state.title === "string"
            ? truncateLogField(part.state.title, 160)
            : undefined,
      };
    }
    case "session.status":
      return {
        type: event.type,
        sessionId: event.properties.sessionID,
        status: event.properties.status.type,
      };
    case "session.idle":
      return {
        type: event.type,
        sessionId: event.properties.sessionID,
      };
    case "session.error":
      return {
        type: event.type,
        sessionId: event.properties.sessionID,
        error: truncateLogField(formatLogValue(event.properties.error)),
      };
    default:
      return {
        type: event.type,
      };
  }
};
