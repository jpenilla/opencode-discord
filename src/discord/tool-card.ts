import { ContainerBuilder, TextDisplayBuilder } from "@discordjs/builders";
import { MessageFlags, type Message, type SendableChannels } from "discord.js";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import {
  SANDBOX_HOME_DIR,
  displaySessionPath,
  resolveSessionPath,
} from "@/sandbox/session-paths.ts";

const EDIT_TOOL_CARDS = true;
export type ToolCardTerminalState = "shutdown";

const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
};

const formatStatus = (part: ToolPart, terminalState?: ToolCardTerminalState) => {
  if (terminalState === "shutdown") {
    return "Stopped";
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

const statusEmoji = (part: ToolPart, terminalState?: ToolCardTerminalState) => {
  if (terminalState === "shutdown") {
    return "🛑";
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

const toolEmoji = (tool: string) => {
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

const formatDuration = (part: ToolPart) => {
  if (part.state.status !== "completed" && part.state.status !== "error") {
    return null;
  }

  const start = part.state.time.start;
  const end = part.state.time.end;
  const milliseconds = Math.max(0, end - start);
  return `${(milliseconds / 1000).toFixed(2)}s`;
};

const titleForPart = (part: ToolPart) =>
  part.state.status === "running" || part.state.status === "completed"
    ? part.state.title
    : undefined;

const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

const quoted = (value: string, maxLength: number) =>
  `\`${truncate(singleLine(value), maxLength)}\``;

const inputObject = (part: ToolPart) => part.state.input;

const findStringInput = (input: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
};

const findUnknownInput = (input: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    if (key in input && input[key] !== undefined && input[key] !== null) {
      return input[key];
    }
  }
  return null;
};

const displayPath = (path: string, workdir: string) => displaySessionPath(workdir, path);

const formatPathSummaryLine = (path: string, workdir: string) => {
  const normalized = displayPath(path, workdir);
  return normalized === "." ? "`.` (cwd)" : `\`${normalized}\``;
};

const normalizeDisplayText = (value: string, workdir: string) => {
  return value.replace(/(?:\/private)?\/[^\s`"'|)]+/g, (token) => displayPath(token, workdir));
};

const normalizePatchFilePath = (path: string, workdir: string) => {
  const trimmed = path.trim();
  const slashPrefixed = trimmed.startsWith(SANDBOX_HOME_DIR.slice(1)) ? `/${trimmed}` : trimmed;
  const displayed = displaySessionPath(workdir, resolveSessionPath(workdir, slashPrefixed));

  if (
    displayed !== "." &&
    !displayed.startsWith("./") &&
    !displayed.startsWith("../") &&
    !displayed.startsWith("~/") &&
    !displayed.startsWith("/")
  ) {
    return `./${displayed}`;
  }

  return displayed;
};

const extractPatchFiles = (value: string, workdir: string) => {
  const hunkFiles = [...value.matchAll(/\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)/g)].map(
    (match) => normalizePatchFilePath(match[1], workdir),
  );
  const outputFiles = [...value.matchAll(/(?:^|\n)(?:A|M|D|R\d+|C\d+)\s+([^\n]+)/g)].map((match) =>
    normalizePatchFilePath(match[1], workdir),
  );
  return [...new Set([...hunkFiles, ...outputFiles])].sort();
};

const formatTextValue = (value: string, workdir: string, maxLength: number) =>
  quoted(normalizeDisplayText(value, workdir), maxLength);

const titleCaseKey = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^./, (value) => value.toUpperCase());

const isPathLikeKey = (key: string) => /(path|file|dir|cwd|root|target|workspace)/i.test(key);

const compactUrl = (value: string) => {
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

const parseWebfetchTitle = (title: string) => {
  const suffixStart = title.lastIndexOf(" (");
  if (suffixStart === -1 || !title.endsWith(")")) {
    return null;
  }

  return {
    url: title.slice(0, suffixStart),
    contentType: title.slice(suffixStart + 2, -1),
  };
};

const summarizeContentType = (value: string) => {
  const mime = value.split(";")[0]?.trim().toLowerCase();
  switch (mime) {
    case "application/json":
      return "JSON";
    case "text/html":
      return "HTML";
    case "text/plain":
      return "Text";
    case "text/markdown":
    case "text/x-markdown":
      return "Markdown";
    default:
      return mime || value;
  }
};

const formatGenericValue = (key: string, value: unknown, workdir: string): string | null => {
  if (typeof value === "string") {
    const url = compactUrl(value);
    if (url) {
      return `\`${truncate(url, 140)}\``;
    }

    if (isPathLikeKey(key)) {
      return `\`${displayPath(value, workdir)}\``;
    }

    return formatTextValue(value, workdir, 160);
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

type MetaField = {
  label: string;
  value: string;
};

type ToolCardLine =
  | {
      kind: "summary";
      text: string;
    }
  | {
      kind: "meta";
      label: string;
      value: string;
    }
  | {
      kind: "meta-group";
      items: MetaField[];
    }
  | {
      kind: "status";
      label: string;
      value: string;
    }
  | {
      kind: "todo";
      text: string;
    };

const summaryLine = (text: string): ToolCardLine => ({ kind: "summary", text });

const metaLine = (label: string, value: string): ToolCardLine => ({
  kind: "meta",
  label,
  value,
});

const metaGroupLine = (items: MetaField[]): ToolCardLine => ({
  kind: "meta-group",
  items,
});

const statusLine = (label: string, value: string): ToolCardLine => ({
  kind: "status",
  label,
  value,
});

const todoLine = (text: string): ToolCardLine => ({ kind: "todo", text });

const metaField = (label: string, value: string | null | undefined): MetaField | null =>
  value ? { label, value } : null;

const renderMetaField = (field: MetaField) => `${field.label}: ${field.value}`;

const flushMetaFields = (fields: MetaField[]): ToolCardLine =>
  fields.length === 1 ? metaLine(fields[0].label, fields[0].value) : metaGroupLine(fields);

const packMetaFields = (fields: Array<MetaField | null>, maxLength = 88): ToolCardLine[] => {
  const compact = fields.filter((field): field is MetaField => field !== null);
  if (compact.length === 0) {
    return [];
  }

  const lines: ToolCardLine[] = [];
  let current: MetaField[] = [];
  let currentLength = 0;

  for (const field of compact) {
    const rendered = renderMetaField(field);
    const nextLength = current.length === 0 ? rendered.length : currentLength + 3 + rendered.length;

    if (current.length > 0 && nextLength > maxLength) {
      lines.push(flushMetaFields(current));
      current = [field];
      currentLength = rendered.length;
      continue;
    }

    current.push(field);
    currentLength = nextLength;
  }

  lines.push(flushMetaFields(current));
  return lines;
};

const renderToolCardLine = (line: ToolCardLine) => {
  switch (line.kind) {
    case "summary":
      return line.text;
    case "meta":
    case "status":
      return `${line.label}: ${line.value}`;
    case "meta-group":
      return line.items.map(renderMetaField).join(" | ");
    case "todo":
      return line.text;
  }
};

const formatGenericInputLines = (input: Record<string, unknown>, workdir: string) => {
  const fields = Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => {
      const formatted = formatGenericValue(key, value, workdir);
      return formatted ? [metaField(titleCaseKey(key), formatted)] : [];
    });

  return packMetaFields(fields);
};

type FormatterInput = {
  part: ToolPart;
  workdir: string;
  input: Record<string, unknown>;
};

type ToolInputFormatter = (input: FormatterInput) => ToolCardLine[];

const formatPatchInputLines: ToolInputFormatter = ({ part, workdir, input }) => {
  const patchInput = findStringInput(input, ["patchText", "patch", "content", "diff", "input"]);
  const patchRaw = "raw" in part.state && typeof part.state.raw === "string" ? part.state.raw : "";
  const patchOutput = part.state.status === "completed" ? part.state.output : "";
  const files = extractPatchFiles(`${patchInput ?? ""}\n${patchRaw}\n${patchOutput}`, workdir);

  if (files.length === 0) {
    return part.state.status === "completed" ? [summaryLine("Applied patch")] : [];
  }

  return [summaryLine(files.map((file) => `\`${file}\``).join(", "))];
};

const formatBashInputLines: ToolInputFormatter = ({ part, workdir, input }) => {
  const command = findStringInput(input, ["cmd", "command", "script", "shell"]);
  if (command) {
    return [summaryLine(formatTextValue(command, workdir, 220))];
  }
  if (
    "raw" in part.state &&
    typeof part.state.raw === "string" &&
    part.state.raw.trim().length > 0
  ) {
    return [summaryLine(formatTextValue(part.state.raw, workdir, 220))];
  }
  return [];
};

const formatReadInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const filePath = findStringInput(input, ["filePath", "path", "filepath", "target"]);
  if (!filePath) {
    return [];
  }
  return [summaryLine(formatPathSummaryLine(filePath, workdir))];
};

const formatGlobInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const pattern = findStringInput(input, ["pattern", "glob", "query"]);
  const path = findStringInput(input, ["path", "cwd", "root"]);
  const hidden = findUnknownInput(input, ["includeHidden", "hidden", "dot"]);
  return packMetaFields([
    metaField("Pattern", pattern ? formatTextValue(pattern, workdir, 180) : null),
    metaField("Path", path ? `\`${displayPath(path, workdir)}\`` : null),
    metaField("Hidden", typeof hidden === "boolean" ? `\`${hidden}\`` : null),
  ]);
};

const formatGrepInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const pattern = findStringInput(input, ["pattern", "query", "search"]);
  const path = findStringInput(input, ["path", "cwd", "root"]);
  const caseSensitive = findUnknownInput(input, ["caseSensitive", "ignoreCase"]);
  const context = findUnknownInput(input, ["context", "before", "after"]);
  return packMetaFields([
    metaField("Pattern", pattern ? formatTextValue(pattern, workdir, 180) : null),
    metaField("Path", path ? `\`${displayPath(path, workdir)}\`` : null),
    metaField("Case Sensitive", typeof caseSensitive === "boolean" ? `\`${caseSensitive}\`` : null),
    metaField("Context", typeof context === "number" ? `\`${context}\`` : null),
  ]);
};

const formatEditInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const path = findStringInput(input, ["filePath", "path", "file"]);
  const search = findStringInput(input, ["oldText", "search", "find"]);
  const replace = findStringInput(input, ["newText", "replace", "replacement"]);
  return packMetaFields([
    metaField("File", path ? `\`${displayPath(path, workdir)}\`` : null),
    metaField(
      "Edit",
      search && replace
        ? formatTextValue(`${singleLine(search)} -> ${singleLine(replace)}`, workdir, 200)
        : null,
    ),
  ]);
};

const formatWriteInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const path = findStringInput(input, ["filePath", "path", "file"]);
  const content = findStringInput(input, ["content", "text"]);
  return [
    ...(path ? [summaryLine(formatPathSummaryLine(path, workdir))] : []),
    ...packMetaFields([metaField("Size", content ? `\`${content.length} chars\`` : null)]),
  ];
};

const formatTaskInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const description = findStringInput(input, ["description", "prompt", "task"]);
  const agent = findStringInput(input, ["agent", "agentID", "subagent_type", "subagentType"]);
  const model = findStringInput(input, ["model", "modelID"]);
  return [
    ...(description ? [summaryLine(formatTextValue(description, workdir, 200))] : []),
    ...packMetaFields([
      metaField("Agent", agent ? `\`${agent}\`` : null),
      metaField("Model", model ? `\`${model}\`` : null),
    ]),
  ];
};

const formatWebfetchInputLines: ToolInputFormatter = ({ part, input }) => {
  const url = findStringInput(input, ["url", "link"]);
  const format = findStringInput(input, ["format"]);
  const metadata: Array<MetaField | null> = [];
  const lines: ToolCardLine[] = [];

  if (url) {
    const compact = compactUrl(url);
    lines.push(summaryLine(`\`${compact ? truncate(compact, 180) : truncate(url, 180)}\``));
  }

  if (format && format !== "markdown") {
    metadata.push(metaField("Format", `\`${format}\``));
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
        metadata.push(metaField("Response", `\`${summarizeContentType(parsed.contentType)}\``));
      }
    }
  }

  return [...lines, ...packMetaFields(metadata)];
};

const formatSearchInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const query = findStringInput(input, ["query", "q", "pattern", "search"]);
  const path = findStringInput(input, ["path", "cwd", "root"]);
  return [
    ...(query ? [summaryLine(formatTextValue(query, workdir, 180))] : []),
    ...packMetaFields([metaField("Path", path ? `\`${displayPath(path, workdir)}\`` : null)]),
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

const formatPlanExitInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const reason = findStringInput(input, ["reason", "message", "status"]);
  return reason ? [statusLine("Exit", formatTextValue(reason, workdir, 180))] : [];
};

const formatBatchInputLines: ToolInputFormatter = ({ input }) => {
  const items = findUnknownInput(input, ["items", "calls", "tasks"]);
  return Array.isArray(items) ? [metaLine("Batched Calls", `\`${items.length}\``)] : [];
};

const formatLspInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const action = findStringInput(input, ["action", "method", "operation"]);
  const path = findStringInput(input, ["path", "filePath", "uri"]);
  return packMetaFields([
    metaField("Action", action ? `\`${action}\`` : null),
    metaField("Path", path ? `\`${displayPath(path, workdir)}\`` : null),
  ]);
};

const formatInvalidInputLines: ToolInputFormatter = ({ workdir, input }) => {
  const reason = findStringInput(input, ["reason", "error", "message"]);
  return reason ? [statusLine("Reason", formatTextValue(reason, workdir, 180))] : [];
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

const formatToolInputLines = (part: ToolPart, workdir: string) => {
  const input = inputObject(part);
  if (part.tool === "apply_patch" || part.tool.includes("patch")) {
    return formatPatchInputLines({ part, workdir, input });
  }

  const formatter = TOOL_INPUT_FORMATTERS[part.tool];
  if (formatter) {
    return formatter({ part, workdir, input });
  }

  return formatGenericInputLines(input, workdir);
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

const formatStepLine = (part: ToolPart, step: string) => {
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

const searchResultInfo = (part: ToolPart): { count: number } | { error: string } | null => {
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

const renderToolCard = (input: {
  part: ToolPart;
  workdir: string;
  terminalState?: ToolCardTerminalState;
}) => {
  const { part, terminalState } = input;
  const duration = terminalState ? null : formatDuration(part);
  const statusLabel = duration
    ? `${formatStatus(part, terminalState)} in ${duration}`
    : formatStatus(part, terminalState);
  const header =
    part.tool === "todowrite"
      ? "**📝 Todo list**"
      : `**${toolEmoji(part.tool)} ${statusEmoji(part, terminalState)} \`${part.tool}\` ${statusLabel}**`;
  const lines = [header];

  const inputLines = formatToolInputLines(part, input.workdir);
  if (inputLines.length > 0) {
    lines.push(...inputLines.map(renderToolCardLine));
  }

  const title = titleForPart(part);
  if (title) {
    const step = normalizeDisplayText(title, input.workdir);
    const stepLine = formatStepLine(part, step);
    if (stepLine) {
      lines.push(renderToolCardLine(stepLine));
    }
  }

  const resultInfo = searchResultInfo(part);
  if (resultInfo && "count" in resultInfo) {
    lines.push(renderToolCardLine(statusLine("Results", `\`${resultInfo.count}\``)));
  } else if (resultInfo && "error" in resultInfo) {
    lines.push(renderToolCardLine(statusLine("Results Error", `\`${resultInfo.error}\``)));
  }

  if (terminalState === "shutdown") {
    lines.push(
      renderToolCardLine(
        statusLine("Note", "This tool did not complete because the bot shut down."),
      ),
    );
  } else if (part.state.status === "error") {
    lines.push(
      renderToolCardLine(
        statusLine(
          "Error",
          `\`${truncate(normalizeDisplayText(part.state.error, input.workdir), 600)}\``,
        ),
      ),
    );
  }

  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join("\n")),
  );

  return [container];
};

const createPayload = (input: {
  part: ToolPart;
  workdir: string;
  includeNotificationSuppression: boolean;
  terminalState?: ToolCardTerminalState;
}) => ({
  flags: input.includeNotificationSuppression
    ? MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications
    : MessageFlags.IsComponentsV2,
  components: renderToolCard({
    part: input.part,
    workdir: input.workdir,
    terminalState: input.terminalState,
  }),
  allowedMentions: { parse: [] as Array<never> },
});

export const upsertToolCard = async (input: {
  sourceMessage: Message;
  existingCard: Message | null;
  part: ToolPart;
  workdir: string;
  mode?: "edit-or-send" | "always-send";
  terminalState?: ToolCardTerminalState;
}) => {
  const mode = input.mode ?? "edit-or-send";
  if (mode === "edit-or-send" && EDIT_TOOL_CARDS && input.existingCard) {
    try {
      await input.existingCard.edit(
        createPayload({
          part: input.part,
          workdir: input.workdir,
          includeNotificationSuppression: false,
          terminalState: input.terminalState,
        }),
      );
      return input.existingCard;
    } catch {
      // fall through and create a fresh card if the previous message was deleted/uneditable.
    }
  }

  if (!input.sourceMessage.channel.isSendable()) {
    throw new Error("Channel is not sendable for tool progress card");
  }

  return (input.sourceMessage.channel as SendableChannels).send(
    createPayload({
      part: input.part,
      workdir: input.workdir,
      includeNotificationSuppression: true,
      terminalState: input.terminalState,
    }),
  );
};

export const editToolCard = (input: {
  card: Message;
  part: ToolPart;
  workdir: string;
  terminalState: ToolCardTerminalState;
}) =>
  input.card.edit(
    createPayload({
      part: input.part,
      workdir: input.workdir,
      includeNotificationSuppression: false,
      terminalState: input.terminalState,
    }),
  );
