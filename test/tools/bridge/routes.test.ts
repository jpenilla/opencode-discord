import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { Effect } from "effect";

import { uploadMetadataHeader } from "@/tools/bridge/handlers/uploads.ts";
import { matchToolBridgeRoute } from "@/tools/bridge/routes.ts";
import { unsafeStub } from "../../support/stub.ts";

const emptyAsyncIterator = (): AsyncIterator<never, undefined, unknown> => ({
  next: async () => ({
    done: true,
    value: undefined,
  }),
});

const makeRequest = (overrides: Record<string, unknown> = {}) =>
  unsafeStub<IncomingMessage>({
    headers: {},
    [Symbol.asyncIterator](): AsyncIterator<never, undefined, unknown> {
      return emptyAsyncIterator();
    },
    ...overrides,
  });

describe("matchToolBridgeRoute", () => {
  test("matches known tool bridge routes by method and path", () => {
    expect(matchToolBridgeRoute("POST", "/tool/send-file")?.operation).toBe("file upload");
    expect(matchToolBridgeRoute("POST", "/tool/send-image")?.operation).toBe("image upload");
    expect(matchToolBridgeRoute("POST", "/tool/list-custom-emojis")?.operation).toBe(
      "custom emoji listing",
    );
    expect(matchToolBridgeRoute("POST", "/tool/list-stickers")?.operation).toBe("sticker listing");
    expect(matchToolBridgeRoute("POST", "/tool/send-sticker")?.operation).toBe("sticker send");
    expect(matchToolBridgeRoute("POST", "/tool/react")?.operation).toBe("reaction");
    expect(matchToolBridgeRoute("POST", "/tool/list-attachments")?.operation).toBe(
      "attachment listing",
    );
  });

  test("returns null for unsupported methods and paths", () => {
    expect(matchToolBridgeRoute("GET", "/tool/send-file")).toBeNull();
    expect(matchToolBridgeRoute("POST", "/tool/unknown")).toBeNull();
  });

  test("parses upload metadata from headers without consuming the request body", async () => {
    const route = matchToolBridgeRoute("POST", "/tool/send-file");
    let didReadBody = false;
    const request = makeRequest({
      headers: {
        [uploadMetadataHeader]: Buffer.from(
          JSON.stringify({
            sessionID: "session-1",
            filename: "report.txt",
            displayPath: "./report.txt",
            caption: "hello",
          }),
        ).toString("base64url"),
      },
      async *[Symbol.asyncIterator](): AsyncGenerator<Buffer, undefined, unknown> {
        didReadBody = true;
        yield Buffer.from("body");
        return undefined;
      },
    });

    await expect(Effect.runPromise(route!.parseRequest(request))).resolves.toEqual({
      sessionID: "session-1",
      payload: {
        sessionID: "session-1",
        filename: "report.txt",
        displayPath: "./report.txt",
        caption: "hello",
      },
    });
    expect(didReadBody).toBe(false);
  });

  test("continues to parse JSON routes from the request body", async () => {
    const route = matchToolBridgeRoute("POST", "/tool/react");
    const request = makeRequest({
      async *[Symbol.asyncIterator](): AsyncGenerator<string, undefined, unknown> {
        yield JSON.stringify({
          sessionID: "session-1",
          messageId: "message-1",
          emoji: "👍",
        });
        return undefined;
      },
    });

    await expect(Effect.runPromise(route!.parseRequest(request))).resolves.toEqual({
      sessionID: "session-1",
      payload: {
        messageId: "message-1",
        emoji: "👍",
      },
    });
  });
});
