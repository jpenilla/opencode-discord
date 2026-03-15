import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  cleanupFailedUpload,
  parseUploadHeaders,
  uploadMetadataHeader,
} from "@/tools/bridge/handlers/uploads.ts";

const encodeUploadHeader = (value: unknown) => {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
};

describe("parseUploadHeaders", () => {
  test("decodes upload metadata from the bridge header", async () => {
    await expect(
      Effect.runPromise(
        parseUploadHeaders({
          [uploadMetadataHeader]: encodeUploadHeader({
            sessionID: "session-1",
            filename: "image.png",
            displayPath: "./assets/image.png",
            caption: "caption text",
          }),
        }),
      ),
    ).resolves.toEqual({
      sessionID: "session-1",
      filename: "image.png",
      displayPath: "./assets/image.png",
      caption: "caption text",
    });
  });

  test("rejects requests with no upload metadata header", async () => {
    await expect(Effect.runPromise(parseUploadHeaders({}))).rejects.toThrow(
      "missing upload metadata",
    );
  });

  test("rejects invalid encoded upload metadata", async () => {
    await expect(
      Effect.runPromise(
        parseUploadHeaders({
          [uploadMetadataHeader]: "not-valid-json",
        }),
      ),
    ).rejects.toThrow("invalid upload metadata");
  });
});

describe("cleanupFailedUpload", () => {
  test("only destroys the outgoing upload stream", async () => {
    let uploadDestroyed = false;

    await expect(
      Effect.runPromise(
        cleanupFailedUpload(
          {
            destroyed: false,
            destroy: () => {
              uploadDestroyed = true;
            },
          },
          new Error("upload failed"),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(uploadDestroyed).toBe(true);
  });
});
