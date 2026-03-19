import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  renderSyntheticGroupFile,
  renderSyntheticPasswdFile,
  stageSandboxConfigDirectory,
} from "@/sandbox/backend.ts";

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

    try {
      const staged = await stageSandboxConfigDirectory(sourceDir);
      const tempRoot = dirname(staged.configDir);

      expect(existsSync(tempRoot)).toBe(true);
      expect(await Bun.file(join(staged.configDir, "config.json")).text()).toBe('{"ok":true}\n');

      await staged.cleanup();

      expect(existsSync(tempRoot)).toBe(false);
    } finally {
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
      await expect(stageSandboxConfigDirectory(sourceDir)).rejects.toThrow();
      const remainingRoots = new Set(
        (await readdir(tmpdir())).filter((entry) => entry.startsWith("opencode-discord-config-")),
      );
      expect(remainingRoots).toEqual(existingRoots);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});
