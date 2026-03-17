import type { ToolPart } from "@opencode-ai/sdk/v2";

import type { ToolCardTerminalState } from "./types.ts";

export const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
};

export const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

export const quoted = (value: string, maxLength: number) =>
  `\`${truncate(singleLine(value), maxLength)}\``;

export const formatTextValue = (value: string, maxLength: number) => quoted(value, maxLength);

export const inputObject = (part: ToolPart) => part.state.input;

export const findStringInput = (input: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
};

export const findUnknownInput = (input: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    if (key in input && input[key] !== undefined && input[key] !== null) {
      return input[key];
    }
  }
  return null;
};

export const formatDuration = (part: ToolPart) => {
  if (part.state.status !== "completed" && part.state.status !== "error") {
    return null;
  }

  const start = part.state.time.start;
  const end = part.state.time.end;
  const milliseconds = Math.max(0, end - start);
  return `${(milliseconds / 1000).toFixed(2)}s`;
};

export const titleForPart = (part: ToolPart) =>
  part.state.status === "running" || part.state.status === "completed"
    ? part.state.title
    : undefined;

export const formatStatus = (part: ToolPart, terminalState?: ToolCardTerminalState) => {
  if (terminalState === "interrupted") {
    return "Interrupted";
  }

  switch (part.state.status) {
    case "pending":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "error":
      return "Failed";
  }
};

export const statusEmoji = (part: ToolPart, terminalState?: ToolCardTerminalState) => {
  if (terminalState === "interrupted") {
    return "‼️";
  }

  switch (part.state.status) {
    case "pending":
      return "⏳";
    case "running":
      return "🛠️";
    case "completed":
      return "✅";
    case "error":
      return "❌";
  }
};

export const toolEmoji = (tool: string) => {
  switch (tool) {
    case "invalid":
      return "⚠️";
    case "bash":
      return "💻";
    case "read":
      return "📖";
    case "glob":
    case "grep":
      return "🔎";
    case "edit":
    case "write":
      return "✏️";
    case "task":
      return "🧩";
    case "webfetch":
    case "websearch":
      return "🌐";
    case "codesearch":
      return "🧠";
    case "skill":
      return "🎯";
    case "apply_patch":
      return "🩹";
    case "todoread":
    case "todowrite":
      return "📝";
    case "plan_exit":
      return "🚪";
    case "batch":
      return "📦";
    case "lsp":
      return "🧭";
    default:
      return tool.includes("patch") ? "🩹" : "🛠️";
  }
};

export const titleCaseKey = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^./, (value) => value.toUpperCase());

export const isPathLikeKey = (key: string) =>
  /(path|file|dir|cwd|root|target|workspace)/i.test(key);

export const compactUrl = (value: string) => {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    const queryEntries = [...url.searchParams.entries()];
    const query =
      queryEntries.length === 0
        ? ""
        : `?${queryEntries
            .slice(0, 2)
            .map(([key, item]) => `${key}=${truncate(item, 24)}`)
            .join("&")}${queryEntries.length > 2 ? "&…" : ""}`;
    return `${url.hostname}${path}${query}`;
  } catch {
    return null;
  }
};

export const parseWebfetchTitle = (title: string) => {
  const suffixStart = title.lastIndexOf(" (");
  if (suffixStart === -1 || !title.endsWith(")")) {
    return null;
  }

  return {
    url: title.slice(0, suffixStart),
    contentType: title.slice(suffixStart + 2, -1),
  };
};
