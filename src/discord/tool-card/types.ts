import type { ToolPart } from "@opencode-ai/sdk/v2";

export type MetaField = {
  label: string;
  value: string;
};

export type ToolCardPathDisplay = {
  displayPath: (path: string) => string;
  formatPathSummaryLine: (path: string) => string;
  extractPatchFiles: (value: string) => {
    add: string[];
    modify: string[];
    remove: string[];
  };
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
  input: Record<string, unknown>;
  pathDisplay: ToolCardPathDisplay;
};

export type ToolInputFormatter = (input: FormatterInput) => ToolCardLine[];
