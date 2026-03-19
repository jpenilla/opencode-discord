import { describe, expect, test } from "bun:test";

import { renderSyntheticGroupFile, renderSyntheticPasswdFile } from "@/sandbox/backend.ts";

describe("renderSyntheticPasswdFile", () => {
  test("renders a passwd entry with the sandbox home", () => {
    expect(
      renderSyntheticPasswdFile({
        username: "jason",
        uid: 1000,
        gid: 1000,
        shell: "/bin/zsh",
      }),
    ).toBe("jason:x:1000:1000:jason:/home/opencode:/bin/zsh\n");
  });

  test("sanitizes passwd fields and falls back to /bin/sh", () => {
    expect(
      renderSyntheticPasswdFile({
        username: "ja:son\n",
        uid: 1000,
        gid: 1000,
        shell: "",
      }),
    ).toBe("jason:x:1000:1000:jason:/home/opencode:/bin/sh\n");
  });
});

describe("renderSyntheticGroupFile", () => {
  test("renders the primary and supplementary groups once each", () => {
    expect(
      renderSyntheticGroupFile({
        username: "jason",
        primaryGid: 1000,
        gids: [4, 1000, 27, 27],
        groupNames: new Map([
          [4, "adm"],
          [27, "sudo"],
          [1000, "jason"],
        ]),
      }),
    ).toBe(["adm:x:4:jason", "sudo:x:27:jason", "jason:x:1000:"].join("\n").concat("\n"));
  });

  test("falls back to synthetic names for unknown supplementary groups", () => {
    expect(
      renderSyntheticGroupFile({
        username: "ja:son\n",
        primaryGid: 1000,
        gids: [1000, 2000],
      }),
    ).toBe(["jason:x:1000:", "gid-2000:x:2000:jason"].join("\n").concat("\n"));
  });
});
