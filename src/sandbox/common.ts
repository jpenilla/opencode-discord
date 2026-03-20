import { fileURLToPath } from "node:url";

import { Data, Effect, FileSystem, Path, Scope, ServiceMap } from "effect";

import type { AppConfigShape } from "@/config.ts";

export type ResolvedSandboxBackend = "unsafe-dev" | "bwrap";

export type SandboxSession = {
  backend: ResolvedSandboxBackend;
  url: string;
  directory: string;
};

export type SandboxStartupStep =
  | "probe-executables"
  | "allocate-port"
  | "stage-config"
  | "stage-host-state"
  | "stage-identity"
  | "launch-server";

export class SandboxStartupFailed extends Data.TaggedError("SandboxStartupFailed")<{
  readonly message: string;
  readonly backend: ResolvedSandboxBackend;
  readonly workdir: string;
  readonly step: SandboxStartupStep;
  readonly cause?: unknown;
}> {}

export type SandboxBackendShape = {
  startSession: (input: {
    workdir: string;
    systemPromptAppend?: string;
  }) => Effect.Effect<
    SandboxSession,
    SandboxStartupFailed,
    Path.Path | FileSystem.FileSystem | Scope.Scope
  >;
};

export class SandboxBackend extends ServiceMap.Service<SandboxBackend, SandboxBackendShape>()(
  "SandboxBackend",
) {}

export const OPENCODE_CONFIG_DIR = fileURLToPath(new URL("../../opencode", import.meta.url));

export const sandboxStartupFailed = (input: {
  message: string;
  backend: ResolvedSandboxBackend;
  workdir: string;
  step: SandboxStartupStep;
  cause?: unknown;
}) => new SandboxStartupFailed(input);

export const wrapStepError =
  (input: {
    message: string;
    backend: ResolvedSandboxBackend;
    workdir: string;
    step: SandboxStartupStep;
  }) =>
  (cause: unknown) =>
    sandboxStartupFailed({ ...input, cause });

export const resolveSandboxBackend = (
  backend: AppConfigShape["sandboxBackend"],
): ResolvedSandboxBackend => {
  if (backend === "unsafe-dev" || backend === "bwrap") {
    return backend;
  }

  return process.platform === "linux" ? "bwrap" : "unsafe-dev";
};
