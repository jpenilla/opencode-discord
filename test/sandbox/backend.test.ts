import { describe, expect, test } from "bun:test";
import { Effect, Layer, Scope } from "effect";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AppConfigShape } from "@/config.ts";
import { AppConfig } from "@/config.ts";
import { SandboxBackendLayer } from "@/sandbox/backend.ts";
import { renderSyntheticGroupFile, renderSyntheticPasswdFile } from "@/sandbox/identity.ts";
import { consumeServerUrlOutput } from "@/sandbox/launch.ts";
import { stageSandboxConfigDirectory } from "@/sandbox/staging.ts";
import { makeTestConfig } from "../support/config.ts";
import { closeTestScope, runTestEffect } from "../support/runtime.ts";

const runEffect = runTestEffect;

const closeScope = closeTestScope;

const makeConfig = (overrides?: Partial<AppConfigShape>): AppConfigShape =>
  makeTestConfig({ stateDir: "/tmp/opencode-discord-test", ...overrides });

describe("consumeServerUrlOutput", () => {
  test("waits for a complete line before parsing the server url", () => {
    const first = consumeServerUrlOutput("", "opencode server listening on http://127.0.0");
    expect(first.url).toBeNull();

    const second = consumeServerUrlOutput(first.pendingLine, ".1:4321\nready\n");
    expect(second.url).toBe("http://127.0.0.1:4321");
  });
});

describe("SandboxBackendLayer", () => {
  test("fails fast when the opencode binary is missing", async () => {
    await expect(
      runEffect(
        Layer.build(
          SandboxBackendLayer.pipe(
            Layer.provide(
              Layer.succeed(AppConfig, makeConfig({ opencodeBin: "/definitely/missing/opencode" })),
            ),
          ),
        ).pipe(Effect.scoped),
      ),
    ).rejects.toThrow("opencode binary not found");
  });
});

describe("renderSyntheticPasswdFile", () => {
  test("renders a passwd entry with the sandbox home", () => {
    expect(
      renderSyntheticPasswdFile({
        username: "jason",
        uid: 1000,
        gid: 1000,
        shell: "/bin/zsh",
      }),
    ).toBe("jason:x:1000:1000:jason:/home/opencode:/bin/zsh\n");
  });

  test("sanitizes passwd fields and falls back to /bin/sh", () => {
    expect(
      renderSyntheticPasswdFile({
        username: "ja:son\n",
        uid: 1000,
        gid: 1000,
        shell: "",
      }),
    ).toBe("jason:x:1000:1000:jason:/home/opencode:/bin/sh\n");
  });
});

describe("renderSyntheticGroupFile", () => {
  test("renders the primary and supplementary groups once each", () => {
    expect(
      renderSyntheticGroupFile({
        username: "jason",
        primaryGid: 1000,
        gids: [4, 1000, 27, 27],
        groupNames: new Map([
          [4, "adm"],
          [27, "sudo"],
          [1000, "jason"],
        ]),
      }),
    ).toBe(["adm:x:4:jason", "sudo:x:27:jason", "jason:x:1000:"].join("\n").concat("\n"));
  });

  test("falls back to synthetic names for unknown supplementary groups", () => {
    expect(
      renderSyntheticGroupFile({
        username: "ja:son\n",
        primaryGid: 1000,
        gids: [1000, 2000],
      }),
    ).toBe(["jason:x:1000:", "gid-2000:x:2000:jason"].join("\n").concat("\n"));
  });
});

describe("stageSandboxConfigDirectory", () => {
  test("keeps the staged temp root until cleanup is called", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "opencode-discord-source-"));
    await writeFile(join(sourceDir, "config.json"), '{"ok":true}\n');
    let scope: Scope.Closeable | null = null;

    try {
      scope = await runEffect(Scope.make());
      const configDir = await runEffect(
        stageSandboxConfigDirectory(sourceDir, "unsafe-dev", sourceDir).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      const tempRoot = dirname(configDir);

      expect(existsSync(tempRoot)).toBe(true);
      expect(await Bun.file(join(configDir, "config.json")).text()).toBe('{"ok":true}\n');

      await closeScope(scope);
      scope = null;

      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      if (scope) {
        await closeScope(scope);
      }
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("cleans the temp root when staging fails", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "opencode-discord-source-"));
    const nodeModulesDir = join(sourceDir, "node_modules");
    const existingRoots = new Set(
      (await readdir(tmpdir())).filter((entry) => entry.startsWith("opencode-discord-config-")),
    );

    await writeFile(join(sourceDir, "config.json"), '{"broken":true}\n');
    await mkdir(nodeModulesDir, { recursive: true });
    await symlink(join(sourceDir, "missing-target"), join(nodeModulesDir, "broken-link"));

    try {
      await expect(
        stageSandboxConfigDirectory(sourceDir, "unsafe-dev", sourceDir).pipe(
          Effect.scoped,
          runEffect,
        ),
      ).rejects.toThrow();
      const remainingRoots = new Set(
        (await readdir(tmpdir())).filter((entry) => entry.startsWith("opencode-discord-config-")),
      );
      expect(remainingRoots).toEqual(existingRoots);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("dereferences staged config symlinks", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "opencode-discord-source-"));
    const targetPath = join(sourceDir, "target.txt");
    const linkedPath = join(sourceDir, "linked.txt");
    let scope: Scope.Closeable | null = null;

    await writeFile(targetPath, "hello\n");
    await symlink(targetPath, linkedPath);

    try {
      scope = await runEffect(Scope.make());
      const configDir = await runEffect(
        stageSandboxConfigDirectory(sourceDir, "unsafe-dev", sourceDir).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );

      expect(await Bun.file(join(configDir, "linked.txt")).text()).toBe("hello\n");
      expect((await lstat(join(configDir, "linked.txt"))).isSymbolicLink()).toBe(false);
    } finally {
      if (scope) {
        await closeScope(scope);
      }
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("dereferences staged config symlinks inside copied directories", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "opencode-discord-source-"));
    const nestedDir = join(sourceDir, "nested");
    const targetPath = join(sourceDir, "target.txt");
    const linkedPath = join(nestedDir, "linked.txt");
    let scope: Scope.Closeable | null = null;

    await mkdir(nestedDir, { recursive: true });
    await writeFile(targetPath, "hello\n");
    await symlink(targetPath, linkedPath);

    try {
      scope = await runEffect(Scope.make());
      const configDir = await runEffect(
        stageSandboxConfigDirectory(sourceDir, "unsafe-dev", sourceDir).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );

      expect(await Bun.file(join(configDir, "nested", "linked.txt")).text()).toBe("hello\n");
      expect((await lstat(join(configDir, "nested", "linked.txt"))).isSymbolicLink()).toBe(false);
    } finally {
      if (scope) {
        await closeScope(scope);
      }
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});
