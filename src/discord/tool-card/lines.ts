import type { MetaField, ToolCardLine } from "./types.ts";

export const summaryLine = (text: string): ToolCardLine => ({ kind: "summary", text });

export const metaLine = (label: string, value: string): ToolCardLine => ({
  kind: "meta",
  label,
  value,
});

export const metaGroupLine = (items: MetaField[]): ToolCardLine => ({
  kind: "meta-group",
  items,
});

export const statusLine = (label: string, value: string): ToolCardLine => ({
  kind: "status",
  label,
  value,
});

export const todoLine = (text: string): ToolCardLine => ({ kind: "todo", text });

export const metaField = (label: string, value: string | null | undefined): MetaField | null =>
  value ? { label, value } : null;

const renderMetaField = (field: MetaField) => `${field.label}: ${field.value}`;

const flushMetaFields = (fields: MetaField[]): ToolCardLine =>
  fields.length === 1 ? metaLine(fields[0].label, fields[0].value) : metaGroupLine(fields);

export const packMetaFields = (fields: Array<MetaField | null>, maxLength = 88): ToolCardLine[] => {
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

export const renderToolCardLine = (line: ToolCardLine) => {
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
