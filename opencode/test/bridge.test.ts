import { describe, expect, test } from "bun:test";

import { formatBridgeMessage } from "../tools/lib/bridge.ts";

describe("formatBridgeMessage", () => {
  test("preserves string messages", () => {
    expect(formatBridgeMessage("ok")).toBe("ok");
  });

  test("pretty-prints structured messages", () => {
    expect(
      formatBridgeMessage({
        description: "Attachments on Discord message m-1",
        list: [
          {
            attachmentId: "att-1",
            name: "report.pdf",
            size: 2048,
            type: "application/pdf",
            url: "https://cdn.discordapp.com/attachments/report.pdf",
          },
        ],
      }),
    ).toBe(`{
  "description": "Attachments on Discord message m-1",
  "list": [
    {
      "attachmentId": "att-1",
      "name": "report.pdf",
      "size": 2048,
      "type": "application/pdf",
      "url": "https://cdn.discordapp.com/attachments/report.pdf"
    }
  ]
}`);
  });

  test("falls back to ok for missing messages", () => {
    expect(formatBridgeMessage(undefined)).toBe("ok");
  });
});
