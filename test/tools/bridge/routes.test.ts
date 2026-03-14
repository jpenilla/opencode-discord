import { describe, expect, test } from "bun:test";

import { matchToolBridgeRoute } from "@/tools/bridge/routes.ts";

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
});
