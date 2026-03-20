import { spawn } from "node:child_process";

import { Effect, Redacted, Scope } from "effect";

import type { AppConfigShape } from "@/config.ts";
import {
  type ResolvedSandboxBackend,
  type SandboxSession,
  type SandboxStartupFailed,
  wrapStepError,
} from "@/sandbox/common.ts";
import { xdgHomes } from "@/sandbox/staging.ts";

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

export type SandboxLaunchConfig = Pick<
  AppConfigShape,
  | "bwrapBin"
  | "opencodeBin"
  | "sandboxEnvPassthrough"
  | "sandboxReadOnlyPaths"
  | "toolBridgeSocketPath"
  | "toolBridgeToken"
>;

export type LaunchSandboxedServerInput = {
  config: SandboxLaunchConfig;
  configDir: string;
  opencodeBin: string;
  bwrapBin?: string;
  systemPromptAppend?: string;
};

export const consumeServerUrlOutput = (pendingLine: string, chunk: Buffer | string) => {
  const lines = `${pendingLine}${chunk.toString()}`.split("\n");
  const nextPendingLine = lines.pop() ?? "";

  for (const line of lines) {
    const match = line.match(/^opencode server listening.*on\s+(https?:\/\/[^\s]+)/);
    if (match?.[1]) {
      return { pendingLine: nextPendingLine, url: match[1] };
    }
  }

  return { pendingLine: nextPendingLine, url: null };
};

const waitForServerUrl = (proc: ReturnType<typeof spawn>, timeout: number, signal?: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for server to start after ${timeout}ms`));
    }, timeout);

    let output = "";
    let pendingLine = "";
    const onChunk = (chunk: Buffer | string) => {
      output += chunk.toString();
      const consumed = consumeServerUrlOutput(pendingLine, chunk);
      pendingLine = consumed.pendingLine;
      if (consumed.url) {
        cleanup();
        resolve(consumed.url);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      let message = `Server exited with code ${code}`;
      if (output.trim()) {
        message += `\nServer output: ${output}`;
      }
      reject(new Error(message));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      proc.kill();
      reject(new Error("Aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout?.off("data", onChunk);
      proc.stderr?.off("data", onChunk);
      proc.off("exit", onExit);
      proc.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("exit", onExit);
    proc.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const shouldPassThroughEnv = (name: string, config: SandboxLaunchConfig) => {
  if (DEFAULT_PASSTHROUGH_ENV_NAMES.has(name)) {
    return true;
  }
  if (DEFAULT_PASSTHROUGH_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  return config.sandboxEnvPassthrough.includes(name);
};

const buildWorkerEnvironment = (config: SandboxLaunchConfig) => {
  const allowedEntries = Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && shouldPassThroughEnv(name, config),
  );
  return Object.fromEntries(allowedEntries);
};

export const baseServerEnvironment = (
  input: LaunchSandboxedServerInput,
  homeDir: string,
  xdg: ReturnType<typeof xdgHomes>,
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

export const spawnServerProcess = (input: {
  backend: ResolvedSandboxBackend;
  workdir: string;
  directory: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Effect.Effect<SandboxSession, SandboxStartupFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const proc = spawn(input.command, input.args, {
          cwd: input.cwd,
          env: input.env,
        });

        try {
          const url = await waitForServerUrl(proc, 10_000);
          return { proc, url };
        } catch (error) {
          proc.kill();
          throw error;
        }
      },
      catch: wrapStepError({
        message: "sandbox server launch failed",
        backend: input.backend,
        workdir: input.workdir,
        step: "launch-server",
      }),
    }),
    ({ proc }) =>
      Effect.sync(() => {
        proc.kill();
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.map(({ url }) => ({
      backend: input.backend,
      url,
      directory: input.directory,
    })),
  );
