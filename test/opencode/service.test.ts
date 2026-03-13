import { describe, expect, test } from "bun:test";
import type { GlobalEvent, PermissionRequest } from "@opencode-ai/sdk/v2";

import {
  summarizeOpencodeEventForLog,
  summarizePermissionForLog,
} from "@/opencode/log-summary.ts";
import { unsafeStub } from "../support/stub.ts";

describe("opencode log summaries", () => {
  test("logs a compact summary for tool events without raw tool payloads", () => {
    const summary = summarizeOpencodeEventForLog(
      unsafeStub<GlobalEvent["payload"]>({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "tool",
            callID: "call-1",
            tool: "webfetch",
            state: {
              status: "completed",
              input: {
                url: "https://example.com",
                response:
                  "<html><body>very large html payload that should never be logged</body></html>",
              },
              output:
                "<html><body>very large html payload that should never be logged</body></html>",
              title: "https://example.com (text/html)",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        },
      }),
    );

    expect(summary).toEqual({
      type: "message.part.updated",
      sessionId: "session-1",
      messageId: "message-1",
      partId: "part-1",
      partType: "tool",
      callId: "call-1",
      tool: "webfetch",
      status: "completed",
      title: "https://example.com (text/html)",
    });
    expect(summary).not.toHaveProperty("input");
    expect(summary).not.toHaveProperty("output");
    expect(JSON.stringify(summary)).not.toContain("very large html payload");
  });

  test("summarizes message.updated summary content without logging raw text", () => {
    const summary = summarizeOpencodeEventForLog(
      unsafeStub<GlobalEvent["payload"]>({
        type: "message.updated",
        properties: {
          info: {
            id: "message-1",
            sessionID: "session-1",
            role: "assistant",
            parentID: "message-0",
            mode: "build",
            summary: "very large assistant summary body that should not be logged verbatim",
            finish: "stop",
            time: {
              created: 1,
              completed: 2,
            },
          },
        },
      }),
    );

    expect(summary).toEqual({
      type: "message.updated",
      sessionId: "session-1",
      messageId: "message-1",
      role: "assistant",
      parentId: "message-0",
      mode: "build",
      summary: {
        kind: "text",
        chars: 68,
      },
      completed: true,
      finish: "stop",
      error: undefined,
    });
    expect(JSON.stringify(summary)).not.toContain("very large assistant summary body");
  });

  test("summarizes permission requests without logging raw payload content", () => {
    const summary = summarizePermissionForLog(
      unsafeStub<PermissionRequest>({
        id: "req-1",
        sessionID: "session-1",
        permission: "bash",
        patterns: ["bash:*"],
        metadata: {
          command:
            "curl https://example.com/some/really/long/url --data '<html>very large permission payload body</html>'",
        },
        always: ["bash:pwd"],
        tool: {
          messageID: "message-1",
          callID: "call-1",
        },
      }),
    );

    expect(summary).toEqual({
      permission: "bash",
      patterns: 1,
      always: 1,
      metadata: {
        kind: "object",
        fields: 1,
        diffs: undefined,
      },
      toolCallId: "call-1",
    });
    expect(JSON.stringify(summary)).not.toContain("very large permission payload body");
    expect(JSON.stringify(summary)).not.toContain("https://example.com/some/really/long/url");
  });
});
