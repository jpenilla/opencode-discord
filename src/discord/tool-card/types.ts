import type { ToolPart } from "@opencode-ai/sdk/v2";

import type { ResolvedSandboxBackend } from "@/sandbox/backend.ts";

export type ToolCardTerminalState = "shutdown";

export type ToolCardPathContext = {
  workdir: string;
  backend: ResolvedSandboxBackend;
};

export type MetaField = {
  label: string;
  value: string;
};

export type ToolCardLine =
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

export type FormatterInput = {
  part: ToolPart;
  pathContext: ToolCardPathContext;
  input: Record<string, unknown>;
};

export type ToolInputFormatter = (input: FormatterInput) => ToolCardLine[];
