import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBridgeUploadPayload, resolveUploadPath } from "../tools/lib/upload.ts";

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-discord-upload-"));
  tempDirs.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveUploadPath", () => {
  test("resolves relative paths against the current cwd", () => {
    expect(resolveUploadPath("./notes.txt", "/tmp/workspace")).toBe("/tmp/workspace/notes.txt");
  });

  test("preserves absolute paths", () => {
    expect(resolveUploadPath("/tmp/workspace/notes.txt", "/tmp/other")).toBe(
      "/tmp/workspace/notes.txt",
    );
  });

  test("rejects blank paths", () => {
    expect(() => resolveUploadPath("   ", "/tmp/workspace")).toThrow("Path must not be blank");
  });
});

describe("buildBridgeUploadPayload", () => {
  test("reads upload bytes relative to the provided cwd and preserves caption metadata", async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, "assets"), { recursive: true });
    await writeFile(join(cwd, "assets", "image.png"), "png-data");

    await expect(
      buildBridgeUploadPayload({
        sessionID: "session-1",
        path: "./assets/image.png",
        caption: "caption text",
        cwd,
      }),
    ).resolves.toEqual({
      sessionID: "session-1",
      filename: "image.png",
      displayPath: "./assets/image.png",
      dataBase64: Buffer.from("png-data").toString("base64"),
      caption: "caption text",
    });
  });

  test("reads upload bytes from an absolute path", async () => {
    const directory = await makeTempDir();
    const filePath = join(directory, "report.txt");
    await writeFile(filePath, "report");

    await expect(
      buildBridgeUploadPayload({
        sessionID: "session-2",
        path: filePath,
      }),
    ).resolves.toEqual({
      sessionID: "session-2",
      filename: "report.txt",
      displayPath: filePath,
      dataBase64: Buffer.from("report").toString("base64"),
    });
  });
});
