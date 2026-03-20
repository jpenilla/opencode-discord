import { cp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";

import { Effect, FileSystem, Option, Path, Scope } from "effect";

import type { ResolvedSandboxBackend, SandboxStartupFailed } from "@/sandbox/common.ts";
import { sandboxStartupFailed, wrapStepError } from "@/sandbox/common.ts";

const IGNORED_GLOBAL_CONFIG_ENTRIES = new Set([
  ".gitignore",
  "bun.lock",
  "node_modules",
  "package.json",
]);

const copyEntry = (
  source: string,
  destination: string,
  options?: {
    ifExists?: boolean;
  },
): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (options?.ifExists) {
      const exists = yield* fs.exists(source);
      if (!exists) {
        return;
      }
    }
    const resolvedSource = yield* fs.readLink(source).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(source),
        onSuccess: () => fs.realPath(source),
      }),
    );

    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* Effect.tryPromise(() =>
      cp(resolvedSource, destination, {
        recursive: true,
        force: true,
        dereference: true,
      }),
    );
  });

const bunPackageStoreRoot = (path: Path.Path, target: string) => {
  let current = target;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    if (path.basename(parent) === ".bun") {
      return current;
    }

    current = parent;
  }
};

const stageNodeModulesDirectory = (
  sourceDir: string,
  destinationDir: string,
  destinationNodeModulesRoot: string,
  copiedStoreRoots: Map<string, string>,
): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(destinationDir, { recursive: true });

    const entries = yield* fs.readDirectory(sourceDir);
    for (const entryName of entries) {
      const sourcePath = path.join(sourceDir, entryName);
      const destinationPath = path.join(destinationDir, entryName);
      const linkTarget = yield* fs.readLink(sourcePath).pipe(Effect.option);

      if (Option.isSome(linkTarget)) {
        const resolvedTarget = yield* fs.realPath(sourcePath);
        const storeRoot = bunPackageStoreRoot(path, resolvedTarget);
        if (!storeRoot) {
          yield* copyEntry(sourcePath, destinationPath);
          continue;
        }

        let stagedStoreRoot = copiedStoreRoots.get(storeRoot);
        if (!stagedStoreRoot) {
          stagedStoreRoot = path.join(destinationNodeModulesRoot, ".bun", path.basename(storeRoot));
          yield* copyEntry(storeRoot, stagedStoreRoot);
          copiedStoreRoots.set(storeRoot, stagedStoreRoot);
        }

        const stagedTarget = path.join(stagedStoreRoot, path.relative(storeRoot, resolvedTarget));
        yield* fs.makeDirectory(path.dirname(destinationPath), { recursive: true });
        yield* fs.symlink(
          path.relative(path.dirname(destinationPath), stagedTarget),
          destinationPath,
        );
        continue;
      }

      const stats = yield* fs.stat(sourcePath);
      if (stats.type === "Directory") {
        yield* stageNodeModulesDirectory(
          sourcePath,
          destinationPath,
          destinationNodeModulesRoot,
          copiedStoreRoots,
        );
        continue;
      }

      yield* copyEntry(sourcePath, destinationPath);
    }
  });

const copySandboxConfigDirectory = (
  sourceDir: string,
  destinationDir: string,
): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(destinationDir, { recursive: true });
    const copiedStoreRoots = new Map<string, string>();
    const entries = yield* fs.readDirectory(sourceDir);
    for (const entryName of entries) {
      const sourcePath = path.join(sourceDir, entryName);
      const destinationPath = path.join(destinationDir, entryName);

      if (entryName === "node_modules") {
        yield* stageNodeModulesDirectory(
          sourcePath,
          destinationPath,
          destinationPath,
          copiedStoreRoots,
        );
        continue;
      }

      yield* copyEntry(sourcePath, destinationPath);
    }
  });

export const stageSandboxConfigDirectory = (
  sourceDir: string,
  backend: ResolvedSandboxBackend,
  workdir: string,
): Effect.Effect<string, SandboxStartupFailed, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const exists = yield* fs.exists(sourceDir).pipe(
      Effect.mapError(
        wrapStepError({
          message: "sandbox config lookup failed",
          backend,
          workdir,
          step: "stage-config",
        }),
      ),
    );
    if (!exists) {
      return yield* sandboxStartupFailed({
        message: `Sandbox config directory not found: ${sourceDir}`,
        backend,
        workdir,
        step: "stage-config",
      });
    }

    const tempRoot = yield* fs
      .makeTempDirectoryScoped({
        directory: tmpdir(),
        prefix: "opencode-discord-config-",
      })
      .pipe(
        Effect.mapError(
          wrapStepError({
            message: "sandbox config staging root creation failed",
            backend,
            workdir,
            step: "stage-config",
          }),
        ),
      );
    const stagedConfigDir = path.join(tempRoot, "opencode");
    yield* copySandboxConfigDirectory(sourceDir, stagedConfigDir).pipe(
      Effect.mapError(
        wrapStepError({
          message: "sandbox config staging failed",
          backend,
          workdir,
          step: "stage-config",
        }),
      ),
    );
    return stagedConfigDir;
  });

export const xdgHomes = (
  path: Path.Path,
  homeDir: string,
  env: Partial<NodeJS.ProcessEnv> = {},
) => ({
  config: env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config"),
  data: env.XDG_DATA_HOME ?? path.join(homeDir, ".local", "share"),
  state: env.XDG_STATE_HOME ?? path.join(homeDir, ".local", "state"),
  cache: env.XDG_CACHE_HOME ?? path.join(homeDir, ".cache"),
});

const copyConfigDirectory = (
  sourceDir: string,
  destinationDir: string,
): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const exists = yield* fs.exists(sourceDir);
    if (!exists) {
      return;
    }

    const entries = yield* fs.readDirectory(sourceDir);
    for (const entryName of entries) {
      if (IGNORED_GLOBAL_CONFIG_ENTRIES.has(entryName)) {
        continue;
      }

      yield* copyEntry(path.join(sourceDir, entryName), path.join(destinationDir, entryName), {
        ifExists: true,
      });
    }
  });

const OPENCODE_STATE_FILES = [
  ["data", "auth.json"],
  ["data", "mcp-auth.json"],
  ["state", "model.json"],
] as const;

export const stageHostOpencodeState = (
  homeDir: string,
  backend: ResolvedSandboxBackend,
  workdir: string,
): Effect.Effect<
  ReturnType<typeof xdgHomes>,
  SandboxStartupFailed,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const hostXdg = xdgHomes(path, homedir(), process.env);
    const workerXdg = xdgHomes(path, homeDir);
    const workerOpencodeDirs = Object.values(workerXdg).map((directory) =>
      path.join(directory, "opencode"),
    );
    const directoriesToCreate = [workerXdg.cache, ...workerOpencodeDirs];

    yield* Effect.forEach(
      directoriesToCreate,
      (directory) => fs.makeDirectory(directory, { recursive: true }),
      {
        concurrency: "unbounded",
        discard: true,
      },
    ).pipe(
      Effect.mapError(
        wrapStepError({
          message: "sandbox state directory creation failed",
          backend,
          workdir,
          step: "stage-host-state",
        }),
      ),
    );
    yield* copyConfigDirectory(
      path.join(hostXdg.config, "opencode"),
      path.join(workerXdg.config, "opencode"),
    ).pipe(
      Effect.mapError(
        wrapStepError({
          message: "sandbox config copy failed",
          backend,
          workdir,
          step: "stage-host-state",
        }),
      ),
    );
    for (const [root, file] of OPENCODE_STATE_FILES) {
      yield* copyEntry(
        path.join(hostXdg[root], "opencode", file),
        path.join(workerXdg[root], "opencode", file),
        { ifExists: true },
      ).pipe(
        Effect.mapError(
          wrapStepError({
            message: "sandbox state file copy failed",
            backend,
            workdir,
            step: "stage-host-state",
          }),
        ),
      );
    }

    return workerXdg;
  });
