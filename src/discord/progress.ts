import type { SessionStatus } from "@opencode-ai/sdk/v2";

export const formatSessionStatus = (status: SessionStatus) => {
  switch (status.type) {
    case "busy":
      return null;
    case "idle":
      return null;
    case "retry":
      return `*↻ retry ${status.attempt}: ${status.message}*`;
  }
};

export const formatThinkingCompleted = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return `*🧠 ${trimmed}*`;
};

export const formatCompactionSummary = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return `🗜️ Compacted Summary\n${trimmed}`;
};
