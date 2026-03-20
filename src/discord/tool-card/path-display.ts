import type { ResolvedSandboxBackend } from "@/sandbox/common.ts";
import {
  displayHostPath,
  displaySessionPath,
  pathAliases,
  resolveHostPath,
  resolveSessionPath,
  SANDBOX_HOME_DIR,
} from "@/sandbox/session-paths.ts";

import type { ToolCardPathDisplay } from "./types.ts";

type NormalizedToolPath = { kind: "resolved"; path: string } | { kind: "raw"; value: string };
type PatchAction = "add" | "modify" | "remove";

export const PATCH_ACTION_ORDER: ReadonlyArray<PatchAction> = ["add", "modify", "remove"];

export const PATCH_ACTION_FORMAT: Record<PatchAction, { emoji: string; label: string }> = {
  add: { emoji: "➕", label: "Added" },
  modify: { emoji: "✏️", label: "Modified" },
  remove: { emoji: "🗑️", label: "Removed" },
};

const isSandboxAliasPath = (path: string) =>
  path === SANDBOX_HOME_DIR ||
  path.startsWith(`${SANDBOX_HOME_DIR}/`) ||
  path.startsWith(SANDBOX_HOME_DIR.slice(1));

const createPatchActionMap = () => ({
  add: new Map<string, string>(),
  modify: new Map<string, string>(),
  remove: new Map<string, string>(),
});

export const makeToolCardPathDisplay = (context: {
  workdir: string;
  backend: ResolvedSandboxBackend;
}): ToolCardPathDisplay => {
  const normalizeToolPath = (value: string): NormalizedToolPath => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { kind: "raw", value: trimmed };
    }

    if (context.backend === "bwrap") {
      const slashPrefixed = trimmed.startsWith(SANDBOX_HOME_DIR.slice(1)) ? `/${trimmed}` : trimmed;
      return {
        kind: "resolved",
        path: resolveSessionPath(context.workdir, slashPrefixed),
      };
    }

    if (isSandboxAliasPath(trimmed)) {
      return { kind: "raw", value: trimmed };
    }

    return {
      kind: "resolved",
      path: resolveHostPath(context.workdir, trimmed),
    };
  };

  const displayNormalizedPath = (value: NormalizedToolPath) =>
    value.kind === "resolved"
      ? context.backend === "bwrap"
        ? displaySessionPath(context.workdir, value.path)
        : displayHostPath(context.workdir, value.path)
      : value.value;

  const displayPath = (value: string) => displayNormalizedPath(normalizeToolPath(value));

  const formatPathSummaryLine = (value: string) => {
    const normalized = displayPath(value);
    return normalized === "." ? "`.` (cwd)" : `\`${normalized}\``;
  };

  const patchPathIdentityKey = (value: NormalizedToolPath) =>
    value.kind === "resolved"
      ? (pathAliases(value.path).sort()[0] ?? value.path)
      : `raw:${value.value}`;

  const displayPatchFilePath = (value: NormalizedToolPath) => {
    const displayed = displayNormalizedPath(value);
    if (
      value.kind === "resolved" &&
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

  const recordPatchFile = (
    groups: ReturnType<typeof createPatchActionMap>,
    action: PatchAction,
    value: string,
  ) => {
    const normalized = normalizeToolPath(value);
    const key = patchPathIdentityKey(normalized);
    const displayed = displayPatchFilePath(normalized);
    for (const candidate of PATCH_ACTION_ORDER) {
      groups[candidate].delete(key);
    }
    groups[action].set(key, displayed);
  };

  const extractPatchFiles = (value: string) => {
    const groups = createPatchActionMap();
    let pendingUpdate: string | null = null;
    const flushPendingUpdate = () => {
      if (!pendingUpdate) {
        return;
      }
      recordPatchFile(groups, "modify", pendingUpdate);
      pendingUpdate = null;
    };

    for (const line of value.split(/\r?\n/)) {
      const add = line.match(/^\*\*\* Add File: (.+)$/);
      if (add) {
        flushPendingUpdate();
        recordPatchFile(groups, "add", add[1]);
        continue;
      }

      const remove = line.match(/^\*\*\* Delete File: (.+)$/);
      if (remove) {
        flushPendingUpdate();
        recordPatchFile(groups, "remove", remove[1]);
        continue;
      }

      const update = line.match(/^\*\*\* Update File: (.+)$/);
      if (update) {
        flushPendingUpdate();
        pendingUpdate = update[1];
        continue;
      }

      const move = line.match(/^\*\*\* Move to: (.+)$/);
      if (move) {
        if (pendingUpdate) {
          recordPatchFile(groups, "remove", pendingUpdate);
          recordPatchFile(groups, "add", move[1]);
          pendingUpdate = null;
        } else {
          recordPatchFile(groups, "modify", move[1]);
        }
        continue;
      }

      if (line.startsWith("*** ")) {
        flushPendingUpdate();
        continue;
      }

      const rawLine = line.trim();
      if (rawLine.length === 0) {
        continue;
      }

      const rename = rawLine.match(/^R\d+\s+(.+?)\s+->\s+(.+)$/);
      if (rename) {
        flushPendingUpdate();
        recordPatchFile(groups, "remove", rename[1]);
        recordPatchFile(groups, "add", rename[2]);
        continue;
      }

      const copy = rawLine.match(/^C\d+\s+(.+?)\s+->\s+(.+)$/);
      if (copy) {
        flushPendingUpdate();
        recordPatchFile(groups, "add", copy[2]);
        continue;
      }

      const status = rawLine.match(/^([AMD])\s+(.+)$/);
      if (!status) {
        continue;
      }

      flushPendingUpdate();
      const action = status[1] === "A" ? "add" : status[1] === "D" ? "remove" : "modify";
      recordPatchFile(groups, action, status[2]);
    }

    flushPendingUpdate();

    return {
      add: [...groups.add.values()].sort(),
      modify: [...groups.modify.values()].sort(),
      remove: [...groups.remove.values()].sort(),
    };
  };

  return {
    displayPath,
    formatPathSummaryLine,
    extractPatchFiles,
  };
};
