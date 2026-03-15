import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { raceBridgeUploadWithResponse } from "../tools/lib/bridge.ts";
import {
  encodeBridgeUploadMetadata,
  prepareBridgeUpload,
  resolveUploadPath,
} from "../tools/lib/upload.ts";

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

describe("prepareBridgeUpload", () => {
  test("builds upload metadata relative to the provided cwd and preserves caption metadata", async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, "assets"), { recursive: true });
    await writeFile(join(cwd, "assets", "image.png"), "png-data");

    expect(
      prepareBridgeUpload({
        sessionID: "session-1",
        path: "./assets/image.png",
        caption: "caption text",
        cwd,
      }),
    ).toEqual({
      resolvedPath: join(cwd, "assets", "image.png"),
      metadata: {
        sessionID: "session-1",
        filename: "image.png",
        displayPath: "./assets/image.png",
        caption: "caption text",
      },
    });
  });

  test("builds upload metadata from an absolute path", async () => {
    const directory = await makeTempDir();
    const filePath = join(directory, "report.txt");
    await writeFile(filePath, "report");

    expect(
      prepareBridgeUpload({
        sessionID: "session-2",
        path: filePath,
      }),
    ).toEqual({
      resolvedPath: filePath,
      metadata: {
        sessionID: "session-2",
        filename: "report.txt",
        displayPath: filePath,
      },
    });
  });
});

describe("encodeBridgeUploadMetadata", () => {
  test("encodes upload metadata as base64url JSON", () => {
    const encoded = encodeBridgeUploadMetadata({
      sessionID: "session-1",
      filename: "image.png",
      displayPath: "./assets/image.png",
      caption: "caption text",
    });

    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({
      sessionID: "session-1",
      filename: "image.png",
      displayPath: "./assets/image.png",
      caption: "caption text",
    });
  });
});

describe("raceBridgeUploadWithResponse", () => {
  test("interrupts the upload when the response wins", async () => {
    let uploadAborted = false;

    await expect(
      raceBridgeUploadWithResponse({
        upload: new Promise<void>(() => undefined),
        response: Promise.resolve("ok"),
        abortUpload: () => {
          uploadAborted = true;
        },
        abortResponse: () => {},
      }),
    ).resolves.toBe("ok");
    expect(uploadAborted).toBe(true);
  });

  test("waits for the response after the upload completes", async () => {
    let didResolveResponse = false;

    await expect(
      raceBridgeUploadWithResponse({
        upload: Promise.resolve(),
        response: new Promise<string>((resolve) => {
          queueMicrotask(() => {
            didResolveResponse = true;
            resolve("ok");
          });
        }),
        abortUpload: () => {},
        abortResponse: () => {},
      }),
    ).resolves.toBe("ok");
    expect(didResolveResponse).toBe(true);
  });

  test("interrupts the response when the upload fails", async () => {
    let responseAborted = false;

    await expect(
      raceBridgeUploadWithResponse({
        upload: Promise.reject(new Error("upload failed")),
        response: new Promise<string>(() => undefined),
        abortUpload: () => {},
        abortResponse: () => {
          responseAborted = true;
        },
      }),
    ).rejects.toThrow("upload failed");
    expect(responseAborted).toBe(true);
  });

  test("interrupts the upload and surfaces a response failure", async () => {
    let uploadAborted = false;

    await expect(
      raceBridgeUploadWithResponse({
        upload: new Promise<void>(() => undefined),
        response: Promise.reject(new Error("bridge failed")),
        abortUpload: () => {
          uploadAborted = true;
        },
        abortResponse: () => {},
      }),
    ).rejects.toThrow("bridge failed");
    expect(uploadAborted).toBe(true);
  });
});
