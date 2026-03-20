import { Effect, FileSystem, Path, Scope } from "effect";

import type { SandboxSession, SandboxStartupFailed } from "@/sandbox/common.ts";
import { sandboxStartupFailed, wrapStepError } from "@/sandbox/common.ts";
import { stageSandboxIdentity } from "@/sandbox/identity.ts";
import {
  baseServerEnvironment,
  spawnServerProcess,
  type LaunchSandboxedServerInput,
} from "@/sandbox/launch.ts";
import { stageHostOpencodeState, xdgHomes } from "@/sandbox/staging.ts";
import {
  SANDBOX_HOME_DIR,
  SANDBOX_WORKSPACE_DIR,
  sessionHomeDir,
} from "@/sandbox/session-paths.ts";

const SANDBOX_TOOL_BRIDGE_SOCKET_PATH = "/run/opencode-discord/bridge.sock";
const DEFAULT_BWRAP_READ_ONLY_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/usr/local",
  "/opt",
  "/nix/store",
  "/run/current-system/sw",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/home/linuxbrew/.linuxbrew",
];
const SANDBOX_IDENTITY_PATHS = ["/etc/passwd", "/etc/group"] as const;

const parentDirectories = (path: Path.Path, target: string) => {
  const directories: string[] = [];
  let current = path.dirname(target);
  while (current !== "/" && current !== ".") {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories.reverse();
};

const appendParentDirectories = (
  path: Path.Path,
  args: string[],
  target: string,
  seen: Set<string>,
) => {
  for (const directory of parentDirectories(path, target)) {
    if (seen.has(directory)) {
      continue;
    }
    seen.add(directory);
    args.push("--dir", directory);
  }
};

const existingReadOnlyPaths = (
  input: LaunchSandboxedServerInput,
  backend: "bwrap",
  workdir: string,
): Effect.Effect<string[], SandboxStartupFailed, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const configured =
      input.config.sandboxReadOnlyPaths.length > 0
        ? input.config.sandboxReadOnlyPaths
        : DEFAULT_BWRAP_READ_ONLY_PATHS;

    const extra = path.isAbsolute(input.opencodeBin) ? [path.dirname(input.opencodeBin)] : [];
    const candidates = [...new Set([input.configDir, ...configured, ...extra])].filter(
      (entry) => !SANDBOX_IDENTITY_PATHS.includes(entry as (typeof SANDBOX_IDENTITY_PATHS)[number]),
    );

    const existing = yield* Effect.forEach(
      candidates,
      (entry) => fs.exists(entry).pipe(Effect.map((exists) => (exists ? entry : null))),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((entries) => entries.filter((entry): entry is string => entry !== null)),
      Effect.mapError(
        wrapStepError({
          message: "sandbox readonly path validation failed",
          backend,
          workdir,
          step: "launch-server",
        }),
      ),
    );
    return existing.sort((left, right) => left.localeCompare(right));
  });

export const launchBwrapServer = (
  input: LaunchSandboxedServerInput,
  workdir: string,
  port: number,
): Effect.Effect<
  SandboxSession,
  SandboxStartupFailed,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const backend = "bwrap";
    const homeDir = sessionHomeDir(workdir);
    yield* stageHostOpencodeState(homeDir, backend, workdir);
    const identity = yield* stageSandboxIdentity(backend, workdir);
    const bridgeExists = yield* fs.exists(input.config.toolBridgeSocketPath).pipe(
      Effect.mapError(
        wrapStepError({
          message: "tool bridge socket lookup failed",
          backend,
          workdir,
          step: "launch-server",
        }),
      ),
    );
    if (!bridgeExists) {
      return yield* sandboxStartupFailed({
        message: `Discord tool bridge socket not found: ${input.config.toolBridgeSocketPath}`,
        backend,
        workdir,
        step: "launch-server",
      });
    }

    const args: string[] = [
      "--die-with-parent",
      "--new-session",
      "--unshare-user-try",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
    ];

    const ensuredDirectories = new Set<string>();
    for (const [source, destination] of [[homeDir, SANDBOX_HOME_DIR]] as const) {
      appendParentDirectories(path, args, destination, ensuredDirectories);
      args.push("--bind", source, destination);
    }

    appendParentDirectories(path, args, SANDBOX_TOOL_BRIDGE_SOCKET_PATH, ensuredDirectories);
    args.push(
      "--ro-bind",
      path.dirname(input.config.toolBridgeSocketPath),
      path.dirname(SANDBOX_TOOL_BRIDGE_SOCKET_PATH),
    );

    for (const [source, destination] of [
      [identity.passwdPath, "/etc/passwd"],
      [identity.groupPath, "/etc/group"],
    ] as const) {
      appendParentDirectories(path, args, destination, ensuredDirectories);
      args.push("--ro-bind", source, destination);
    }

    for (const mount of yield* existingReadOnlyPaths(input, backend, workdir)) {
      appendParentDirectories(path, args, mount, ensuredDirectories);
      args.push("--ro-bind", mount, mount);
    }

    for (const [key, value] of Object.entries(
      baseServerEnvironment(
        input,
        SANDBOX_HOME_DIR,
        xdgHomes(path, SANDBOX_HOME_DIR),
        SANDBOX_TOOL_BRIDGE_SOCKET_PATH,
      ),
    )) {
      if (value === undefined) {
        continue;
      }
      args.push("--setenv", key, value);
    }

    args.push(
      "--chdir",
      SANDBOX_WORKSPACE_DIR,
      input.opencodeBin,
      "serve",
      "--hostname=127.0.0.1",
      `--port=${port}`,
    );

    return yield* spawnServerProcess({
      backend,
      workdir,
      directory: SANDBOX_WORKSPACE_DIR,
      command: input.bwrapBin!,
      args,
      cwd: workdir,
    });
  });
