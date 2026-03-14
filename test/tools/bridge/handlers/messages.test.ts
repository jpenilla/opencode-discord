import { describe, expect, test } from "bun:test";

import { formatAttachmentList } from "@/tools/bridge/handlers/messages.ts";

describe("formatAttachmentList", () => {
  test("formats attachment metadata and URLs as stable structured data", () => {
    expect(
      formatAttachmentList([
        {
          attachmentId: "att-1",
          name: "report.pdf",
          contentType: "application/pdf",
          size: 2048,
          url: "https://cdn.discordapp.com/attachments/report.pdf",
        },
        {
          attachmentId: "att-2",
          name: "image.png",
          contentType: null,
          size: 512,
          url: "https://cdn.discordapp.com/attachments/image.png",
        },
      ]),
    ).toEqual([
      {
        attachmentId: "att-1",
        name: "report.pdf",
        size: 2048,
        type: "application/pdf",
        url: "https://cdn.discordapp.com/attachments/report.pdf",
      },
      {
        attachmentId: "att-2",
        name: "image.png",
        size: 512,
        type: "unknown",
        url: "https://cdn.discordapp.com/attachments/image.png",
      },
    ]);
  });
});
