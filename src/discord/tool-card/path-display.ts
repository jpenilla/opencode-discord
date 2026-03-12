import { resolve } from "node:path";

import {
  SANDBOX_HOME_DIR,
  displayHostPath,
  displaySessionPath,
  pathAliases,
  resolveHostPath,
  resolveSessionPath,
} from "@/sandbox/session-paths.ts";

import type { ToolCardPathContext } from "./types.ts";

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

const normalizeToolPath = (path: string, context: ToolCardPathContext): NormalizedToolPath => {
  const trimmed = path.trim();
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

const displayResolvedPath = (path: string, context: ToolCardPathContext) =>
  context.backend === "bwrap"
    ? displaySessionPath(context.workdir, path)
    : displayHostPath(context.workdir, path);

const displayNormalizedPath = (path: NormalizedToolPath, context: ToolCardPathContext) =>
  path.kind === "resolved" ? displayResolvedPath(path.path, context) : path.value;

export const displayPath = (path: string, context: ToolCardPathContext) =>
  displayNormalizedPath(normalizeToolPath(path, context), context);

export const formatPathSummaryLine = (path: string, context: ToolCardPathContext) => {
  const normalized = displayPath(path, context);
  return normalized === "." ? "`.` (cwd)" : `\`${normalized}\``;
};

const patchPathIdentityKey = (path: NormalizedToolPath) =>
  path.kind === "resolved"
    ? (pathAliases(resolve(path.path)).sort()[0] ?? path.path)
    : `raw:${path.value}`;

const displayPatchFilePath = (path: NormalizedToolPath, context: ToolCardPathContext) => {
  const displayed = displayNormalizedPath(path, context);

  if (path.kind !== "resolved") {
    return displayed;
  }

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

const createPatchActionMap = () => ({
  add: new Map<string, string>(),
  modify: new Map<string, string>(),
  remove: new Map<string, string>(),
});

const recordPatchFile = (
  groups: ReturnType<typeof createPatchActionMap>,
  action: PatchAction,
  path: string,
  context: ToolCardPathContext,
) => {
  const normalized = normalizeToolPath(path, context);
  const key = patchPathIdentityKey(normalized);
  const displayed = displayPatchFilePath(normalized, context);
  for (const candidate of PATCH_ACTION_ORDER) {
    groups[candidate].delete(key);
  }
  groups[action].set(key, displayed);
};

const collectPatchHunkFiles = (
  value: string,
  groups: ReturnType<typeof createPatchActionMap>,
  context: ToolCardPathContext,
) => {
  let pendingUpdate: string | null = null;
  const flushPendingUpdate = () => {
    if (!pendingUpdate) {
      return;
    }
    recordPatchFile(groups, "modify", pendingUpdate, context);
    pendingUpdate = null;
  };

  for (const line of value.split(/\r?\n/)) {
    const add = line.match(/^\*\*\* Add File: (.+)$/);
    if (add) {
      flushPendingUpdate();
      recordPatchFile(groups, "add", add[1], context);
      continue;
    }

    const remove = line.match(/^\*\*\* Delete File: (.+)$/);
    if (remove) {
      flushPendingUpdate();
      recordPatchFile(groups, "remove", remove[1], context);
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
        recordPatchFile(groups, "remove", pendingUpdate, context);
        recordPatchFile(groups, "add", move[1], context);
        pendingUpdate = null;
      } else {
        recordPatchFile(groups, "modify", move[1], context);
      }
      continue;
    }

    if (line.startsWith("*** ")) {
      flushPendingUpdate();
    }
  }

  flushPendingUpdate();
};

const collectPatchOutputFiles = (
  value: string,
  groups: ReturnType<typeof createPatchActionMap>,
  context: ToolCardPathContext,
) => {
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const rename = line.match(/^R\d+\s+(.+?)\s+->\s+(.+)$/);
    if (rename) {
      recordPatchFile(groups, "remove", rename[1], context);
      recordPatchFile(groups, "add", rename[2], context);
      continue;
    }

    const copy = line.match(/^C\d+\s+(.+?)\s+->\s+(.+)$/);
    if (copy) {
      recordPatchFile(groups, "add", copy[2], context);
      continue;
    }

    const status = line.match(/^([AMD])\s+(.+)$/);
    if (!status) {
      continue;
    }

    const action = status[1] === "A" ? "add" : status[1] === "D" ? "remove" : "modify";
    recordPatchFile(groups, action, status[2], context);
  }
};

export const extractPatchFiles = (value: string, context: ToolCardPathContext) => {
  const groups = createPatchActionMap();
  collectPatchHunkFiles(value, groups, context);
  collectPatchOutputFiles(value, groups, context);

  return {
    add: [...groups.add.values()].sort(),
    modify: [...groups.modify.values()].sort(),
    remove: [...groups.remove.values()].sort(),
  } as const;
};
