import { Redacted } from "effect";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { AppConfigShape } from "@/config.ts";
import {
  SANDBOX_HOME_DIR,
  SANDBOX_WORKSPACE_DIR,
  sessionHomeDir,
} from "@/sandbox/session-paths.ts";

export type ResolvedSandboxBackend = "unsafe-dev" | "bwrap";

export type SandboxedServer = {
  backend: ResolvedSandboxBackend;
  url: string;
  close: () => void;
};

export type ProbedExecutables = {
  backend: ResolvedSandboxBackend;
  opencodeBin: string;
  bwrapBin?: string;
};

export type StagedSandboxConfig = {
  configDir: string;
  cleanup: () => Promise<void>;
};

type LaunchSandboxedServerInput = {
  config: Pick<
    AppConfigShape,
    | "bwrapBin"
    | "opencodeBin"
    | "sandboxBackend"
    | "sandboxEnvPassthrough"
    | "sandboxReadOnlyPaths"
    | "toolBridgeSocketPath"
    | "toolBridgeToken"
  >;
  configDir: string;
  workdir: string;
  systemPromptAppend?: string;
};

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

const DEFAULT_PASSTHROUGH_ENV_NAMES = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "COLORTERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);

const DEFAULT_PASSTHROUGH_ENV_PREFIXES = ["LC_"];

const SANDBOX_TOOL_BRIDGE_SOCKET_PATH = "/run/opencode-discord/bridge.sock";
const IGNORED_GLOBAL_CONFIG_ENTRIES = new Set([
  ".gitignore",
  "bun.lock",
  "node_modules",
  "package.json",
]);

const resolveSandboxBackend = (
  backend: AppConfigShape["sandboxBackend"],
): ResolvedSandboxBackend => {
  if (backend === "unsafe-dev" || backend === "bwrap") {
    return backend;
  }

  return process.platform === "linux" ? "bwrap" : "unsafe-dev";
};

const hasPathSegments = (command: string) => command.includes("/") || command.includes("\\");

const resolveSpawnBinary = (command: string, label: string) => {
  const located = isAbsolute(command)
    ? command
    : hasPathSegments(command)
      ? resolve(command)
      : Bun.which(command);

  if (!located) {
    throw new Error(`${label} binary not found in PATH: ${command}`);
  }

  if (!existsSync(located)) {
    throw new Error(`${label} binary not found: ${located}`);
  }

  try {
    return realpathSync(located);
  } catch {
    return located;
  }
};

export const probeSandboxExecutables = (
  config: Pick<AppConfigShape, "bwrapBin" | "opencodeBin" | "sandboxBackend">,
): ProbedExecutables => {
  const backend = resolveSandboxBackend(config.sandboxBackend);
  const opencodeBin = resolveSpawnBinary(config.opencodeBin, "opencode");
  const bwrapBin = backend === "bwrap" ? resolveSpawnBinary(config.bwrapBin, "bwrap") : undefined;

  return {
    backend,
    opencodeBin,
    bwrapBin,
  };
};

const copyResolvedEntry = async (source: string, destination: string) => {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
    dereference: true,
  });
};

const bunPackageStoreRoot = (target: string) => {
  let current = target;
  while (true) {
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    if (basename(parent) === ".bun") {
      return current;
    }

    current = parent;
  }
};

const stageNodeModulesDirectory = async (
  sourceDir: string,
  destinationDir: string,
  destinationNodeModulesRoot: string,
  copiedStoreRoots: Map<string, string>,
) => {
  await mkdir(destinationDir, { recursive: true });

  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    const stats = await lstat(sourcePath);

    if (stats.isSymbolicLink()) {
      const resolvedTarget = await realpath(sourcePath);
      const storeRoot = bunPackageStoreRoot(resolvedTarget);
      if (!storeRoot) {
        await copyResolvedEntry(sourcePath, destinationPath);
        continue;
      }

      let stagedStoreRoot = copiedStoreRoots.get(storeRoot);
      if (!stagedStoreRoot) {
        stagedStoreRoot = join(destinationNodeModulesRoot, ".bun", basename(storeRoot));
        await copyResolvedEntry(storeRoot, stagedStoreRoot);
        copiedStoreRoots.set(storeRoot, stagedStoreRoot);
      }

      const stagedTarget = join(stagedStoreRoot, relative(storeRoot, resolvedTarget));
      await mkdir(dirname(destinationPath), { recursive: true });
      await symlink(relative(dirname(destinationPath), stagedTarget), destinationPath);
      continue;
    }

    if (stats.isDirectory()) {
      await stageNodeModulesDirectory(
        sourcePath,
        destinationPath,
        destinationNodeModulesRoot,
        copiedStoreRoots,
      );
      continue;
    }

    await copyResolvedEntry(sourcePath, destinationPath);
  }
};

export const stageSandboxConfigDirectory = async (
  sourceDir: string,
): Promise<StagedSandboxConfig> => {
  if (!existsSync(sourceDir)) {
    throw new Error(`Sandbox config directory not found: ${sourceDir}`);
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "opencode-discord-config-"));
  const stagedConfigDir = join(tempRoot, "opencode");
  const cleanup = async () => {
    await rm(tempRoot, { recursive: true, force: true });
  };

  try {
    await mkdir(stagedConfigDir, { recursive: true });

    const copiedStoreRoots = new Map<string, string>();
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name);
      const destinationPath = join(stagedConfigDir, entry.name);

      if (entry.name === "node_modules") {
        await stageNodeModulesDirectory(
          sourcePath,
          destinationPath,
          destinationPath,
          copiedStoreRoots,
        );
        continue;
      }

      await copyResolvedEntry(sourcePath, destinationPath);
    }

    return {
      configDir: stagedConfigDir,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

const nextAvailablePort = async () =>
  await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate local port for opencode worker"));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });

const parentDirectories = (target: string) => {
  const directories: string[] = [];
  let current = dirname(target);
  while (current !== "/" && current !== ".") {
    directories.push(current);
    current = dirname(current);
  }
  return directories.reverse();
};

const appendParentDirectories = (args: string[], target: string, seen: Set<string>) => {
  for (const directory of parentDirectories(target)) {
    if (seen.has(directory)) {
      continue;
    }
    seen.add(directory);
    args.push("--dir", directory);
  }
};

const waitForServerUrl = (proc: ReturnType<typeof spawn>, timeout: number, signal?: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for server to start after ${timeout}ms`));
    }, timeout);

    let output = "";
    const onChunk = (chunk: Buffer | string) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.startsWith("opencode server listening")) {
          continue;
        }

        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          clearTimeout(timer);
          reject(new Error(`Failed to parse server url from output: ${line}`));
          return;
        }

        clearTimeout(timer);
        resolve(match[1]);
        return;
      }
    };

    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      let message = `Server exited with code ${code}`;
      if (output.trim()) {
        message += `\nServer output: ${output}`;
      }
      reject(new Error(message));
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    });
  });

const shouldPassThroughEnv = (name: string, config: LaunchSandboxedServerInput["config"]) => {
  if (DEFAULT_PASSTHROUGH_ENV_NAMES.has(name)) {
    return true;
  }
  if (DEFAULT_PASSTHROUGH_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  return config.sandboxEnvPassthrough.includes(name);
};

const buildWorkerEnvironment = (config: LaunchSandboxedServerInput["config"]) => {
  const allowedEntries = Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && shouldPassThroughEnv(name, config),
  );
  return Object.fromEntries(allowedEntries);
};

const hostXdgHomes = () => {
  const home = homedir();
  return {
    config: process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
    data: process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
    state: process.env.XDG_STATE_HOME ?? join(home, ".local", "state"),
    cache: process.env.XDG_CACHE_HOME ?? join(home, ".cache"),
  };
};

const workerXdgHomes = (homeDir: string) => {
  return {
    config: join(homeDir, ".config"),
    data: join(homeDir, ".local", "share"),
    state: join(homeDir, ".local", "state"),
    cache: join(homeDir, ".cache"),
  };
};

const copyInto = async (source: string, destination: string) => {
  if (!existsSync(source)) {
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
  });
};

const copyConfigDirectory = async (sourceDir: string, destinationDir: string) => {
  if (!existsSync(sourceDir)) {
    return;
  }

  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_GLOBAL_CONFIG_ENTRIES.has(entry.name)) {
      continue;
    }

    await copyInto(join(sourceDir, entry.name), join(destinationDir, entry.name));
  }
};

const stageHostOpencodeState = async (homeDir: string) => {
  const hostXdg = hostXdgHomes();
  const workerXdg = workerXdgHomes(homeDir);

  await mkdir(join(workerXdg.config, "opencode"), { recursive: true });
  await mkdir(join(workerXdg.data, "opencode"), { recursive: true });
  await mkdir(join(workerXdg.state, "opencode"), { recursive: true });
  await mkdir(join(workerXdg.cache, "opencode"), { recursive: true });

  await copyConfigDirectory(join(hostXdg.config, "opencode"), join(workerXdg.config, "opencode"));
  await copyInto(
    join(hostXdg.data, "opencode", "auth.json"),
    join(workerXdg.data, "opencode", "auth.json"),
  );
  await copyInto(
    join(hostXdg.data, "opencode", "mcp-auth.json"),
    join(workerXdg.data, "opencode", "mcp-auth.json"),
  );
  await copyInto(
    join(hostXdg.state, "opencode", "model.json"),
    join(workerXdg.state, "opencode", "model.json"),
  );

  return workerXdg;
};

const baseServerEnvironment = (
  input: LaunchSandboxedServerInput,
  homeDir: string,
  xdg: ReturnType<typeof workerXdgHomes>,
  bridgeSocketPath: string,
) => ({
  ...buildWorkerEnvironment(input.config),
  HOME: homeDir,
  XDG_CONFIG_HOME: xdg.config,
  XDG_DATA_HOME: xdg.data,
  XDG_STATE_HOME: xdg.state,
  XDG_CACHE_HOME: xdg.cache,
  OPENCODE_DISCORD_BRIDGE_SOCKET: bridgeSocketPath,
  OPENCODE_DISCORD_BRIDGE_TOKEN: Redacted.value(input.config.toolBridgeToken),
  ...(input.systemPromptAppend?.trim()
    ? { OPENCODE_DISCORD_SYSTEM_APPEND: input.systemPromptAppend }
    : {}),
  OPENCODE_CONFIG_DIR: input.configDir,
  TMPDIR: "/tmp",
});

const existingReadOnlyPaths = (input: LaunchSandboxedServerInput, opencodeBin: string) => {
  const configured =
    input.config.sandboxReadOnlyPaths.length > 0
      ? input.config.sandboxReadOnlyPaths
      : DEFAULT_BWRAP_READ_ONLY_PATHS;

  const extra = isAbsolute(opencodeBin) ? [dirname(opencodeBin)] : [];
  const paths = [...new Set([input.configDir, ...configured, ...extra])].filter((entry) =>
    existsSync(entry),
  );
  return paths.sort((left, right) => left.localeCompare(right));
};

const launchUnsafeDevServer = async (
  input: LaunchSandboxedServerInput,
  port: number,
): Promise<SandboxedServer> => {
  const homeDir = sessionHomeDir(input.workdir);
  const xdg = await stageHostOpencodeState(homeDir);
  await mkdir(xdg.cache, { recursive: true });

  const opencodeBin = resolveSpawnBinary(input.config.opencodeBin, "opencode");
  const proc = spawn(opencodeBin, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd: input.workdir,
    env: baseServerEnvironment(input, homeDir, xdg, input.config.toolBridgeSocketPath),
  });

  const url = await waitForServerUrl(proc, 10_000);
  return {
    backend: "unsafe-dev",
    url,
    close: () => {
      proc.kill();
    },
  };
};

const launchBwrapServer = async (
  input: LaunchSandboxedServerInput,
  port: number,
): Promise<SandboxedServer> => {
  const homeDir = sessionHomeDir(input.workdir);
  const hostXdg = await stageHostOpencodeState(homeDir);
  await mkdir(hostXdg.cache, { recursive: true });

  const opencodeBin = resolveSpawnBinary(input.config.opencodeBin, "opencode");
  const bwrapBin = resolveSpawnBinary(input.config.bwrapBin, "bwrap");
  if (!existsSync(input.config.toolBridgeSocketPath)) {
    throw new Error(`Discord tool bridge socket not found: ${input.config.toolBridgeSocketPath}`);
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
  const writeableMounts = [[homeDir, SANDBOX_HOME_DIR]] as const;
  for (const [source, destination] of writeableMounts) {
    appendParentDirectories(args, destination, ensuredDirectories);
    args.push("--bind", source, destination);
  }

  appendParentDirectories(args, SANDBOX_TOOL_BRIDGE_SOCKET_PATH, ensuredDirectories);
  args.push(
    "--ro-bind",
    dirname(input.config.toolBridgeSocketPath),
    dirname(SANDBOX_TOOL_BRIDGE_SOCKET_PATH),
  );

  for (const mount of existingReadOnlyPaths(input, opencodeBin)) {
    appendParentDirectories(args, mount, ensuredDirectories);
    args.push("--ro-bind", mount, mount);
  }

  const environment = baseServerEnvironment(
    input,
    SANDBOX_HOME_DIR,
    workerXdgHomes(SANDBOX_HOME_DIR),
    SANDBOX_TOOL_BRIDGE_SOCKET_PATH,
  );
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      continue;
    }
    args.push("--setenv", key, value);
  }

  args.push(
    "--chdir",
    SANDBOX_WORKSPACE_DIR,
    opencodeBin,
    "serve",
    "--hostname=127.0.0.1",
    `--port=${port}`,
  );

  const proc = spawn(bwrapBin, args, {
    cwd: input.workdir,
  });

  const url = await waitForServerUrl(proc, 10_000);
  return {
    backend: "bwrap",
    url,
    close: () => {
      proc.kill();
    },
  };
};

export const launchSandboxedServer = async (
  input: LaunchSandboxedServerInput,
): Promise<SandboxedServer> => {
  const backend = resolveSandboxBackend(input.config.sandboxBackend);
  const port = await nextAvailablePort();

  switch (backend) {
    case "unsafe-dev":
      return await launchUnsafeDevServer(input, port);
    case "bwrap":
      if (process.platform !== "linux") {
        throw new Error("bwrap sandbox backend is only supported on Linux");
      }
      return await launchBwrapServer(input, port);
  }
};

export const describeSandboxBackend = (backend: AppConfigShape["sandboxBackend"]) =>
  resolveSandboxBackend(backend);
