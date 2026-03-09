import { describe, expect, test } from "bun:test"

import { createOpencodeMessageId } from "@/opencode/ids.ts"

describe("createOpencodeMessageId", () => {
  test("creates message ids accepted by opencode prompt submission", () => {
    const id = createOpencodeMessageId()

    expect(id.startsWith("msg_")).toBe(true)
    expect(id).not.toContain("-")
  })
})
