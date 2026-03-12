import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const SANDBOX_HOME_DIR = "/home/opencode";
export const SANDBOX_WORKSPACE_DIR = `${SANDBOX_HOME_DIR}/workspace`;

export const sessionHomeDir = (workdir: string) => dirname(resolve(workdir));

export const pathAliases = (path: string) => {
  const normalized = resolve(path);
  const aliases = new Set<string>([normalized]);
  if (normalized.startsWith("/private/")) {
    aliases.add(normalized.slice("/private".length));
  } else if (normalized.startsWith("/var/")) {
    aliases.add(`/private${normalized}`);
  }
  return [...aliases];
};

export const relativeToAliasedRoot = (root: string, candidate: string) => {
  for (const rootAlias of pathAliases(root)) {
    for (const candidateAlias of pathAliases(candidate)) {
      const rel = relative(rootAlias, candidateAlias);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        return rel;
      }
    }
  }
  return null;
};

export const insideAliasedRoot = (root: string, candidate: string) =>
  relativeToAliasedRoot(root, candidate) !== null;

const hostPathForSandboxAlias = (workdir: string, candidate: string) => {
  if (candidate === SANDBOX_HOME_DIR) {
    return sessionHomeDir(workdir);
  }
  if (candidate.startsWith(`${SANDBOX_HOME_DIR}/`)) {
    return resolve(sessionHomeDir(workdir), candidate.slice(SANDBOX_HOME_DIR.length + 1));
  }
  return null;
};

export const resolveSessionPath = (workdir: string, candidate: string) => {
  const normalized = candidate.trim();
  if (normalized === "~") {
    return sessionHomeDir(workdir);
  }
  if (normalized.startsWith("~/")) {
    return resolve(sessionHomeDir(workdir), normalized.slice(2));
  }

  const sandboxAlias = hostPathForSandboxAlias(workdir, normalized);
  if (sandboxAlias) {
    return sandboxAlias;
  }

  return isAbsolute(normalized) ? resolve(normalized) : resolve(workdir, normalized);
};

export const resolveHostPath = (workdir: string, candidate: string, homeDir = homedir()) => {
  const normalized = candidate.trim();
  if (normalized === "~") {
    return resolve(homeDir);
  }
  if (normalized.startsWith("~/")) {
    return resolve(homeDir, normalized.slice(2));
  }

  return isAbsolute(normalized) ? resolve(normalized) : resolve(workdir, normalized);
};

const displayPath = (input: {
  workdir: string;
  homeDir: string;
  candidate: string;
  resolvePath: (candidate: string) => string;
  includeSandboxAlias: boolean;
}) => {
  const trimmed = input.candidate.trim();
  const shouldResolve =
    trimmed === "." ||
    trimmed === ".." ||
    trimmed === "~" ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("/") ||
    (input.includeSandboxAlias && trimmed.startsWith(SANDBOX_HOME_DIR));

  if (!shouldResolve) {
    return input.candidate;
  }

  const resolvedCandidate = input.resolvePath(trimmed);
  const resolvedWorkdir = resolve(input.workdir);
  const workdirRelative = relativeToAliasedRoot(resolvedWorkdir, resolvedCandidate);
  if (workdirRelative === "") {
    return ".";
  }
  if (workdirRelative) {
    return `./${workdirRelative}`;
  }

  const homeRelative = relativeToAliasedRoot(resolve(input.homeDir), resolvedCandidate);
  if (homeRelative === "") {
    return "~";
  }
  if (homeRelative) {
    return `~/${homeRelative}`;
  }

  return input.candidate;
};

export const displaySessionPath = (workdir: string, candidate: string) =>
  displayPath({
    workdir,
    homeDir: sessionHomeDir(workdir),
    candidate,
    resolvePath: (value) => resolveSessionPath(workdir, value),
    includeSandboxAlias: true,
  });

export const displayHostPath = (workdir: string, candidate: string, homeDir = homedir()) =>
  displayPath({
    workdir,
    homeDir,
    candidate,
    resolvePath: (value) => resolveHostPath(workdir, value, homeDir),
    includeSandboxAlias: false,
  });
