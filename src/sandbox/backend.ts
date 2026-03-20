import { createServer } from "node:net";

import { Effect, FileSystem, Layer, Path, Scope } from "effect";

import { AppConfig, type AppConfigShape } from "@/config.ts";
import { launchBwrapServer } from "@/sandbox/bwrap.ts";
import {
  resolveSandboxBackend,
  OPENCODE_CONFIG_DIR,
  sandboxStartupFailed,
  SandboxBackend,
  type SandboxBackendShape,
  type ResolvedSandboxBackend,
  wrapStepError,
} from "@/sandbox/common.ts";
import {
  baseServerEnvironment,
  spawnServerProcess,
  type LaunchSandboxedServerInput,
} from "@/sandbox/launch.ts";
import { sessionHomeDir } from "@/sandbox/session-paths.ts";
import { stageSandboxConfigDirectory, stageHostOpencodeState } from "@/sandbox/staging.ts";

const hasPathSegments = (command: string) => command.includes("/") || command.includes("\\");

const resolveSpawnBinary = (
  command: string,
  label: string,
  backend: ResolvedSandboxBackend,
  workdir: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;

    const located = path.isAbsolute(command)
      ? command
      : hasPathSegments(command)
        ? path.resolve(command)
        : Bun.which(command);

    if (!located) {
      return yield* sandboxStartupFailed({
        message: `${label} binary not found in PATH: ${command}`,
        backend,
        workdir,
        step: "probe-executables",
      });
    }

    const exists = yield* fs.exists(located).pipe(
      Effect.mapError(
        wrapStepError({
          message: `${label} binary lookup failed`,
          backend,
          workdir,
          step: "probe-executables",
        }),
      ),
    );
    if (!exists) {
      return yield* sandboxStartupFailed({
        message: `${label} binary not found: ${located}`,
        backend,
        workdir,
        step: "probe-executables",
      });
    }

    return yield* fs.realPath(located).pipe(
      Effect.orElseSucceed(() => located),
      Effect.mapError(
        wrapStepError({
          message: `${label} binary realpath failed`,
          backend,
          workdir,
          step: "probe-executables",
        }),
      ),
    );
  });

const resolveExecutables = (
  config: Pick<AppConfigShape, "bwrapBin" | "opencodeBin">,
  backend: ResolvedSandboxBackend,
  workdir: string,
) =>
  Effect.gen(function* () {
    const opencodeBin = yield* resolveSpawnBinary(config.opencodeBin, "opencode", backend, workdir);
    const bwrapBin =
      backend === "bwrap"
        ? yield* resolveSpawnBinary(config.bwrapBin, "bwrap", backend, workdir)
        : undefined;

    return { opencodeBin, bwrapBin };
  });

const nextAvailablePort = (backend: ResolvedSandboxBackend, workdir: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
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
      }),
    catch: wrapStepError({
      message: "sandbox port allocation failed",
      backend,
      workdir,
      step: "allocate-port",
    }),
  });

const launchUnsafeDevServer = (input: LaunchSandboxedServerInput, workdir: string, port: number) =>
  Effect.gen(function* () {
    const backend = "unsafe-dev";
    const homeDir = sessionHomeDir(workdir);
    const xdg = yield* stageHostOpencodeState(homeDir, backend, workdir);

    return yield* spawnServerProcess({
      backend,
      workdir,
      directory: workdir,
      command: input.opencodeBin,
      args: ["serve", "--hostname=127.0.0.1", `--port=${port}`],
      cwd: workdir,
      env: baseServerEnvironment(input, homeDir, xdg, input.config.toolBridgeSocketPath),
    });
  });

export const SandboxBackendLayer = Layer.effect(
  SandboxBackend,
  Effect.gen(function* () {
    const startupWorkdir = process.cwd();
    const config = yield* AppConfig;
    const backend = resolveSandboxBackend(config.sandboxBackend);
    if (backend === "bwrap" && process.platform !== "linux") {
      return yield* sandboxStartupFailed({
        message: "bwrap sandbox backend is only supported on Linux",
        backend,
        workdir: startupWorkdir,
        step: "launch-server",
      });
    }
    const executables = yield* resolveExecutables(config, backend, startupWorkdir);
    const configDir =
      backend === "bwrap"
        ? yield* stageSandboxConfigDirectory(OPENCODE_CONFIG_DIR, backend, startupWorkdir)
        : OPENCODE_CONFIG_DIR;

    const startSession: SandboxBackendShape["startSession"] = ({ workdir, systemPromptAppend }) =>
      Effect.gen(function* () {
        const port = yield* nextAvailablePort(backend, workdir);
        const launchInput = {
          config,
          configDir,
          opencodeBin: executables.opencodeBin,
          bwrapBin: executables.bwrapBin,
          systemPromptAppend,
        };

        switch (backend) {
          case "unsafe-dev":
            return yield* launchUnsafeDevServer(launchInput, workdir, port);
          case "bwrap":
            return yield* launchBwrapServer(launchInput, workdir, port);
        }
      });

    return {
      startSession,
    } satisfies SandboxBackendShape;
  }),
);
