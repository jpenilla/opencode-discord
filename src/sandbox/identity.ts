import { tmpdir, userInfo } from "node:os";

import { Effect, FileSystem, Option, Path, Scope } from "effect";

import type { ResolvedSandboxBackend, SandboxStartupFailed } from "@/sandbox/common.ts";
import { wrapStepError } from "@/sandbox/common.ts";
import { SANDBOX_HOME_DIR } from "@/sandbox/session-paths.ts";

type StagedSandboxIdentity = {
  passwdPath: string;
  groupPath: string;
};

const sanitizeIdentityField = (value: string, fallback: string) => {
  const sanitized = value.replaceAll(":", "").replaceAll("\n", "").replaceAll("\r", "");
  return sanitized || fallback;
};

const parseGroupNames = (content: string) => {
  const groupNames = new Map<number, string>();
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const [name = "", , gidField = ""] = line.split(":", 4);
    const gid = Number.parseInt(gidField, 10);
    if (!Number.isInteger(gid) || gid < 0) {
      continue;
    }

    groupNames.set(gid, sanitizeIdentityField(name, `gid-${gid}`));
  }
  return groupNames;
};

const hostGroupNames = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString("/etc/group").pipe(Effect.option);
    return Option.match(content, {
      onNone: () => new Map<number, string>(),
      onSome: parseGroupNames,
    });
  });

export const renderSyntheticPasswdFile = (input: {
  username: string;
  uid: number;
  gid: number;
  shell?: string;
  homeDir?: string;
}) => {
  const username = sanitizeIdentityField(input.username, "opencode");
  const shell = sanitizeIdentityField(input.shell?.trim() || "/bin/sh", "/bin/sh");
  const homeDir = sanitizeIdentityField(input.homeDir ?? SANDBOX_HOME_DIR, SANDBOX_HOME_DIR);
  return `${username}:x:${input.uid}:${input.gid}:${username}:${homeDir}:${shell}\n`;
};

export const renderSyntheticGroupFile = (input: {
  username: string;
  primaryGid: number;
  gids: ReadonlyArray<number>;
  groupNames?: ReadonlyMap<number, string>;
}) => {
  const username = sanitizeIdentityField(input.username, "opencode");
  const gids = [...new Set(input.gids)].sort((left, right) => left - right);
  return gids
    .map((gid) => {
      const fallbackName = gid === input.primaryGid ? username : `gid-${gid}`;
      const name = sanitizeIdentityField(input.groupNames?.get(gid) ?? fallbackName, fallbackName);
      const members = gid === input.primaryGid ? "" : username;
      return `${name}:x:${gid}:${members}`;
    })
    .join("\n")
    .concat("\n");
};

export const stageSandboxIdentity = (
  backend: ResolvedSandboxBackend,
  workdir: string,
): Effect.Effect<
  StagedSandboxIdentity,
  SandboxStartupFailed,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const tempRoot = yield* fs
      .makeTempDirectoryScoped({
        directory: tmpdir(),
        prefix: "opencode-discord-identity-",
      })
      .pipe(
        Effect.mapError(
          wrapStepError({
            message: "sandbox identity temp root creation failed",
            backend,
            workdir,
            step: "stage-identity",
          }),
        ),
      );
    const currentUser = userInfo();
    const gids = [...new Set([currentUser.gid, ...(process.getgroups?.() ?? [])])].sort(
      (left, right) => left - right,
    );
    const groupNames = yield* hostGroupNames().pipe(
      Effect.mapError(
        wrapStepError({
          message: "sandbox group lookup failed",
          backend,
          workdir,
          step: "stage-identity",
        }),
      ),
    );
    const passwdPath = path.join(tempRoot, "passwd");
    const groupPath = path.join(tempRoot, "group");

    yield* fs
      .writeFileString(
        passwdPath,
        renderSyntheticPasswdFile({
          username: currentUser.username,
          uid: currentUser.uid,
          gid: currentUser.gid,
          shell: currentUser.shell ?? undefined,
        }),
      )
      .pipe(
        Effect.mapError(
          wrapStepError({
            message: "sandbox passwd file staging failed",
            backend,
            workdir,
            step: "stage-identity",
          }),
        ),
      );
    yield* fs
      .writeFileString(
        groupPath,
        renderSyntheticGroupFile({
          username: currentUser.username,
          primaryGid: currentUser.gid,
          gids,
          groupNames,
        }),
      )
      .pipe(
        Effect.mapError(
          wrapStepError({
            message: "sandbox group file staging failed",
            backend,
            workdir,
            step: "stage-identity",
          }),
        ),
      );

    return {
      passwdPath,
      groupPath,
    } satisfies StagedSandboxIdentity;
  });
