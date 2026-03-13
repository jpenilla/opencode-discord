import type { ToolPart } from "@opencode-ai/sdk/v2";

import {
  metaField,
  metaLine,
  packMetaFields,
  renderToolCardLine,
  statusLine,
  summaryLine,
  todoLine,
} from "./lines.ts";
import type { ToolCardLine, ToolCardPathContext, ToolInputFormatter } from "./types.ts";
import {
  extractPatchFiles,
  displayPath,
  formatPathSummaryLine,
  PATCH_ACTION_FORMAT,
  PATCH_ACTION_ORDER,
} from "./path-display.ts";
import {
  compactUrl,
  findStringInput,
  findUnknownInput,
  formatTextValue,
  inputObject,
  isPathLikeKey,
  parseWebfetchTitle,
  singleLine,
  titleCaseKey,
  titleForPart,
  truncate,
} from "./utils.ts";

const formatGenericValue = (
  key: string,
  value: unknown,
  pathContext: ToolCardPathContext,
): string | null => {
  if (typeof value === "string") {
    const url = compactUrl(value);
    if (url) {
      return `\`${truncate(url, 140)}\``;
    }

    if (isPathLikeKey(key)) {
      return `\`${displayPath(value, pathContext)}\``;
    }

    return formatTextValue(value, 160);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return `\`${String(value)}\``;
  }

  if (Array.isArray(value)) {
    return `\`${value.length} items\``;
  }

  if (value && typeof value === "object") {
    return `\`${Object.keys(value).length} fields\``;
  }

  return null;
};

const formatGenericInputLines = (
  input: Record<string, unknown>,
  pathContext: ToolCardPathContext,
) => {
  const fields = Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => {
      const formatted = formatGenericValue(key, value, pathContext);
      return formatted ? [metaField(titleCaseKey(key), formatted)] : [];
    });

  return packMetaFields(fields);
};

const formatPatchInputLines: ToolInputFormatter = ({ part, pathContext, input }) => {
  const patchInput = findStringInput(input, ["patchText", "patch", "content", "diff", "input"]);
  const patchRaw = "raw" in part.state && typeof part.state.raw === "string" ? part.state.raw : "";
  const patchOutput = part.state.status === "completed" ? part.state.output : "";
  const files = extractPatchFiles(`${patchInput ?? ""}\n${patchRaw}\n${patchOutput}`, pathContext);

  if (PATCH_ACTION_ORDER.every((action) => files[action].length === 0)) {
    return part.state.status === "completed" ? [summaryLine("Applied patch")] : [];
  }

  return PATCH_ACTION_ORDER.flatMap((action) => {
    const entries = files[action];
    if (entries.length === 0) {
      return [];
    }

    const format = PATCH_ACTION_FORMAT[action];
    return [
      summaryLine(
        `${format.emoji} ${format.label}: ${entries.map((file) => `\`${file}\``).join(", ")}`,
      ),
    ];
  });
};

const formatBashInputLines: ToolInputFormatter = ({ part, input }) => {
  const command = findStringInput(input, ["cmd", "command", "script", "shell"]);
  if (command) {
    return [summaryLine(formatTextValue(command, 220))];
  }
  if (
    "raw" in part.state &&
    typeof part.state.raw === "string" &&
    part.state.raw.trim().length > 0
  ) {
    return [summaryLine(formatTextValue(part.state.raw, 220))];
  }
  return [];
};

const formatReadInputLines: ToolInputFormatter = ({ pathContext, input }) => {
  const filePath = findStringInput(input, ["filePath", "path", "filepath", "target"]);
  if (!filePath) {
    return [];
  }
  return [summaryLine(formatPathSummaryLine(filePath, pathContext))];
};

const formatGlobInputLines: ToolInputFormatter = ({ pathContext, input }) => {
  const pattern = findStringInput(input, ["pattern", "glob", "query"]);
  const path = findStringInput(input, ["path", "cwd", "root"]);
  const hidden = findUnknownInput(input, ["includeHidden", "hidden", "dot"]);
  return packMetaFields([
    metaField("Pattern", pattern ? formatTextValue(pattern, 180) : null),
    metaField("Path", path ? `\`${displayPath(path, pathContext)}\`` : null),
    metaField("Hidden", typeof hidden === "boolean" ? `\`${hidden}\`` : null),
  ]);
};

const formatGrepInputLines: ToolInputFormatter = ({ pathContext, input }) => {
  const pattern = findStringInput(input, ["pattern", "query", "search"]);
  const path = findStringInput(input, ["path", "cwd", "root"]);
  const caseSensitive = findUnknownInput(input, ["caseSensitive", "ignoreCase"]);
  const context = findUnknownInput(input, ["context", "before", "after"]);
  return packMetaFields([
    metaField("Pattern", pattern ? formatTextValue(pattern, 180) : null),
    metaField("Path", path ? `\`${displayPath(path, pathContext)}\`` : null),
    metaField("Case Sensitive", typeof caseSensitive === "boolean" ? `\`${caseSensitive}\`` : null),
    metaField("Context", typeof context === "number" ? `\`${context}\`` : null),
  ]);
};

const formatEditInputLines: ToolInputFormatter = ({ pathContext, input }) => {
  const path = findStringInput(input, ["filePath", "path", "file"]);
  const search = findStringInput(input, ["oldText", "search", "find"]);
  const replace = findStringInput(input, ["newText", "replace", "replacement"]);
  return packMetaFields([
    metaField("File", path ? `\`${displayPath(path, pathContext)}\`` : null),
    metaField(
      "Edit",
      search && replace
        ? formatTextValue(`${singleLine(search)} -> ${singleLine(replace)}`, 200)
        : null,
    ),
  ]);
};

const formatWriteInputLines: ToolInputFormatter = ({ pathContext, input }) => {
  const path = findStringInput(input, ["filePath", "path", "file"]);
  const content = findStringInput(input, ["content", "text"]);
  return [
    ...(path ? [summaryLine(formatPathSummaryLine(path, pathContext))] : []),
    ...packMetaFields([metaField("Size", content ? `\`${content.length} chars\`` : null)]),
  ];
};

const formatTaskInputLines: ToolInputFormatter = ({ input }) => {
  const description = findStringInput(input, ["description", "prompt", "task"]);
  const agent = findStringInput(input, ["agent", "agentID", "subagent_type", "subagentType"]);
  const model = findStringInput(input, ["model", "modelID"]);
  return [
    ...(description ? [summaryLine(formatTextValue(description, 200))] : []),
    ...packMetaFields([
      metaField("Agent", agent ? `\`${agent}\`` : null),
      metaField("Model", model ? `\`${model}\`` : null),
    ]),
  ];
};

const formatWebfetchInputLines: ToolInputFormatter = ({ part, input }) => {
  const url = findStringInput(input, ["url", "link"]);
  const format = findStringInput(input, ["format"]);
  const metadata: Array<ReturnType<typeof metaField>> = [];
  const lines: ToolCardLine[] = [];
  let responseContentType: string | null = null;

  if (url) {
    const compact = compactUrl(url);
    lines.push(summaryLine(`\`${compact ? truncate(compact, 180) : truncate(url, 180)}\``));
  }

  if (part.state.status === "completed") {
    const title = titleForPart(part);
    if (title) {
      const parsed = parseWebfetchTitle(title);
      if (parsed) {
        if (url && parsed.url !== url) {
          const finalUrl = compactUrl(parsed.url);
          metadata.push(
            metaField(
              "Final URL",
              `\`${finalUrl ? truncate(finalUrl, 180) : truncate(parsed.url, 180)}\``,
            ),
          );
        }
        responseContentType = parsed.contentType;
      }
    }
  }

  if (format) {
    metadata.push(metaField("Requested", `\`${format}\``));
  }
  if (responseContentType) {
    metadata.push(metaField("Response", `\`${responseContentType}\``));
  }

  return [...lines, ...packMetaFields(metadata)];
};

const formatSearchInputLines: ToolInputFormatter = ({ pathContext, input }) => {
  const query = findStringInput(input, ["query", "q", "pattern", "search"]);
  const path = findStringInput(input, ["path", "cwd", "root"]);
  return [
    ...(query ? [summaryLine(formatTextValue(query, 180))] : []),
    ...packMetaFields([metaField("Path", path ? `\`${displayPath(path, pathContext)}\`` : null)]),
  ];
};

const formatSkillInputLines: ToolInputFormatter = ({ input }) => {
  const name = findStringInput(input, ["name", "skill", "id"]);
  const action = findStringInput(input, ["action", "mode", "op"]);
  return packMetaFields([
    metaField("Skill", name ? `\`${name}\`` : null),
    metaField("Action", action ? `\`${action}\`` : null),
  ]);
};

const formatTodoInputLines: ToolInputFormatter = ({ input }) => {
  const todos = findUnknownInput(input, ["todos", "items", "tasks"]);
  if (!Array.isArray(todos)) {
    return [];
  }

  const lines: ToolCardLine[] = [];
  for (const todo of todos) {
    if (!todo || typeof todo !== "object") {
      continue;
    }

    const record = todo as Record<string, unknown>;
    const content =
      (typeof record.content === "string" && record.content) ||
      (typeof record.text === "string" && record.text) ||
      (typeof record.title === "string" && record.title) ||
      "(untitled)";
    const status =
      (typeof record.status === "string" && record.status) ||
      (typeof record.state === "string" && record.state) ||
      (typeof record.done === "boolean" ? (record.done ? "done" : "pending") : "");
    const normalizedStatus = status.toLowerCase();
    const emoji =
      normalizedStatus === "done" || normalizedStatus === "completed"
        ? "✅"
        : normalizedStatus === "in_progress" || normalizedStatus === "in progress"
          ? "⏳"
          : normalizedStatus === "cancelled" || normalizedStatus === "canceled"
            ? "⛔"
            : "🕒";

    lines.push(todoLine(`${emoji} ${truncate(singleLine(content), 120)}`));
  }
  return lines;
};

const formatPlanExitInputLines: ToolInputFormatter = ({ input }) => {
  const reason = findStringInput(input, ["reason", "message", "status"]);
  return reason ? [statusLine("Exit", formatTextValue(reason, 180))] : [];
};

const formatBatchInputLines: ToolInputFormatter = ({ input }) => {
  const items = findUnknownInput(input, ["items", "calls", "tasks"]);
  return Array.isArray(items) ? [metaLine("Batched Calls", `\`${items.length}\``)] : [];
};

const formatLspInputLines: ToolInputFormatter = ({ pathContext, input }) => {
  const action = findStringInput(input, ["action", "method", "operation"]);
  const path = findStringInput(input, ["path", "filePath", "uri"]);
  return packMetaFields([
    metaField("Action", action ? `\`${action}\`` : null),
    metaField("Path", path ? `\`${displayPath(path, pathContext)}\`` : null),
  ]);
};

const formatInvalidInputLines: ToolInputFormatter = ({ input }) => {
  const reason = findStringInput(input, ["reason", "error", "message"]);
  return reason ? [statusLine("Reason", formatTextValue(reason, 180))] : [];
};

const TOOL_INPUT_FORMATTERS: Record<string, ToolInputFormatter> = {
  bash: formatBashInputLines,
  read: formatReadInputLines,
  glob: formatGlobInputLines,
  grep: formatGrepInputLines,
  edit: formatEditInputLines,
  write: formatWriteInputLines,
  task: formatTaskInputLines,
  webfetch: formatWebfetchInputLines,
  websearch: formatSearchInputLines,
  codesearch: formatSearchInputLines,
  skill: formatSkillInputLines,
  todoread: formatTodoInputLines,
  todowrite: formatTodoInputLines,
  plan_exit: formatPlanExitInputLines,
  batch: formatBatchInputLines,
  lsp: formatLspInputLines,
  invalid: formatInvalidInputLines,
};

export const formatToolInputLines = (part: ToolPart, pathContext: ToolCardPathContext) => {
  const input = inputObject(part);
  if (part.tool === "apply_patch" || part.tool.includes("patch")) {
    return formatPatchInputLines({ part, pathContext, input });
  }

  const formatter = TOOL_INPUT_FORMATTERS[part.tool];
  if (formatter) {
    return formatter({ part, pathContext, input });
  }

  return formatGenericInputLines(input, pathContext);
};

type StepDisplayMode = "hidden" | "summary" | "meta";

const TOOL_STEP_DISPLAY: Record<string, StepDisplayMode> = {
  bash: "summary",
  read: "hidden",
  write: "hidden",
  task: "hidden",
  todowrite: "hidden",
  grep: "hidden",
  webfetch: "hidden",
  websearch: "hidden",
  codesearch: "hidden",
};

const stepDisplayMode = (tool: string): StepDisplayMode => {
  if (tool.includes("patch")) {
    return "hidden";
  }

  return TOOL_STEP_DISPLAY[tool] ?? "meta";
};

const shouldShowStep = (step: string) => {
  const compact = singleLine(step);
  if (compact.length === 0 || compact.length > 140) {
    return false;
  }
  if (compact === "." || compact.startsWith("./")) {
    return false;
  }
  if (/^[./\w-]+$/.test(compact)) {
    return false;
  }
  return true;
};

export const formatStepLine = (part: ToolPart) => {
  const title = titleForPart(part);
  if (!title) {
    return null;
  }

  const step = singleLine(title);
  if (!shouldShowStep(step)) {
    return null;
  }

  switch (stepDisplayMode(part.tool)) {
    case "hidden":
      return null;
    case "summary":
      return summaryLine(step);
    case "meta":
      return metaLine("Step", step);
  }
};

export const searchResultInfo = (part: ToolPart): { count: number } | { error: string } | null => {
  if (part.state.status !== "completed") {
    return null;
  }

  if (part.tool === "glob") {
    const count = part.state.metadata?.count;
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      return { count };
    }
    return { error: "unexpected glob metadata (count missing)" };
  }

  if (part.tool === "grep") {
    const matches = part.state.metadata?.matches;
    if (typeof matches === "number" && Number.isFinite(matches) && matches >= 0) {
      return { count: matches };
    }
    return { error: "unexpected grep metadata (matches missing)" };
  }

  return null;
};

export { renderToolCardLine, statusLine };
