import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
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
    return expect(
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
    return expect(Effect.runPromise(parseUploadHeaders({}))).rejects.toThrow(
      "missing upload metadata",
    );
  });

  test("rejects invalid encoded upload metadata", async () => {
    return expect(
      Effect.runPromise(
        parseUploadHeaders({
          [uploadMetadataHeader]: "not-valid-json",
        }),
      ),
    ).rejects.toThrow("invalid upload metadata");
  });
});

describe("cleanupFailedUpload", () => {
  test("drains the remaining request body when the request supports resume", async () => {
    let requestResumed = false;
    let requestUnpiped = false;
    let uploadDestroyed = false;
    const request: Pick<IncomingMessage, "resume" | "unpipe"> & { complete: boolean } = {
      complete: false,
      resume: () => {
        requestResumed = true;
        return request as IncomingMessage;
      },
      unpipe: () => {
        requestUnpiped = true;
        return request as IncomingMessage;
      },
    };

    const result = await Effect.runPromise(
      cleanupFailedUpload(request, {
        destroyed: false,
        destroy: () => {
          uploadDestroyed = true;
        },
      }),
    );

    expect(result).toBeUndefined();
    expect(requestResumed).toBe(true);
    expect(requestUnpiped).toBe(true);
    expect(uploadDestroyed).toBe(true);
    expect(request.complete).toBe(false);
  });

  test("falls back to pausing the request body when resume is unavailable", async () => {
    let requestPaused = false;
    let requestUnpiped = false;
    let uploadDestroyed = false;
    const request: Pick<IncomingMessage, "pause" | "unpipe"> = {
      pause: () => {
        requestPaused = true;
        return request as IncomingMessage;
      },
      unpipe: () => {
        requestUnpiped = true;
        return request as IncomingMessage;
      },
    };

    const result = await Effect.runPromise(
      cleanupFailedUpload(request, {
        destroyed: false,
        destroy: () => {
          uploadDestroyed = true;
        },
      }),
    );

    expect(result).toBeUndefined();
    expect(requestPaused).toBe(true);
    expect(requestUnpiped).toBe(true);
    expect(uploadDestroyed).toBe(true);
  });
});
