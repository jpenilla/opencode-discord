import { describe, expect, test } from "bun:test";

import {
  SANDBOX_HOME_DIR,
  displayHostPath,
  displaySessionPath,
  insideAliasedRoot,
  resolveHostPath,
  resolveSessionPath,
  sessionHomeDir,
} from "@/sandbox/session-paths.ts";

describe("sessionHomeDir", () => {
  test("returns the parent home directory for a workspace", () => {
    expect(sessionHomeDir("/tmp/session-1/workspace")).toBe("/tmp/session-1");
  });

  test("normalizes the workspace path before deriving the home directory", () => {
    expect(sessionHomeDir("/tmp/session-1/workspace/../workspace")).toBe("/tmp/session-1");
  });
});

describe("insideAliasedRoot", () => {
  test("treats /private/tmp and /tmp as aliased roots", () => {
    expect(insideAliasedRoot("/tmp/session-1", "/private/tmp/session-1/workspace/file.txt")).toBe(
      true,
    );
  });

  test("treats /var and /private/var as aliased roots", () => {
    expect(
      insideAliasedRoot(
        "/var/folders/abc/session-1",
        "/private/var/folders/abc/session-1/file.txt",
      ),
    ).toBe(true);
  });

  test("returns false for paths outside the root", () => {
    expect(insideAliasedRoot("/tmp/session-1/workspace", "/tmp/session-1/other/file.txt")).toBe(
      false,
    );
  });
});

describe("resolveSessionPath", () => {
  const workdir = "/tmp/session-1/workspace";

  test("resolves ~ to the synthetic session home", () => {
    expect(resolveSessionPath(workdir, "~")).toBe("/tmp/session-1");
  });

  test("resolves ~/... beneath the synthetic session home", () => {
    expect(resolveSessionPath(workdir, "~/logs/out.txt")).toBe("/tmp/session-1/logs/out.txt");
  });

  test("resolves the sandbox home alias to the host session home", () => {
    expect(resolveSessionPath(workdir, SANDBOX_HOME_DIR)).toBe("/tmp/session-1");
  });

  test("resolves sandbox workspace aliases to host workspace paths", () => {
    expect(resolveSessionPath(workdir, "/home/opencode/workspace/file.txt")).toBe(
      "/tmp/session-1/workspace/file.txt",
    );
  });

  test("resolves workspace-relative paths beneath the workdir", () => {
    expect(resolveSessionPath(workdir, "./file.txt")).toBe("/tmp/session-1/workspace/file.txt");
  });

  test("resolves parent-relative paths into the synthetic session home", () => {
    expect(resolveSessionPath(workdir, "../logs/out.txt")).toBe("/tmp/session-1/logs/out.txt");
  });

  test("leaves unrelated absolute host paths unchanged", () => {
    expect(resolveSessionPath(workdir, "/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("resolveHostPath", () => {
  const workdir = "/Users/test/project";

  test("resolves ~ to the real home directory", () => {
    expect(resolveHostPath(workdir, "~", "/Users/test")).toBe("/Users/test");
  });

  test("resolves ~/... beneath the real home directory", () => {
    expect(resolveHostPath(workdir, "~/logs/out.txt", "/Users/test")).toBe(
      "/Users/test/logs/out.txt",
    );
  });

  test("resolves relative paths beneath the workdir", () => {
    expect(resolveHostPath(workdir, "./src/index.ts", "/Users/test")).toBe(
      "/Users/test/project/src/index.ts",
    );
  });
});

describe("displaySessionPath", () => {
  const workdir = "/tmp/session-1/workspace";

  test("renders the absolute host workdir as .", () => {
    expect(displaySessionPath(workdir, workdir)).toBe(".");
  });

  test("renders the sandbox home alias as ~", () => {
    expect(displaySessionPath(workdir, SANDBOX_HOME_DIR)).toBe("~");
  });

  test("renders sandbox workspace aliases relative to the workspace", () => {
    expect(displaySessionPath(workdir, "/home/opencode/workspace/file.txt")).toBe("./file.txt");
  });

  test("renders host home children relative to ~", () => {
    expect(displaySessionPath(workdir, "/tmp/session-1/logs/out.txt")).toBe("~/logs/out.txt");
  });

  test("canonicalizes parent-relative input to ~ display form", () => {
    expect(displaySessionPath(workdir, "../logs/out.txt")).toBe("~/logs/out.txt");
  });

  test("handles /private/tmp alias paths against a /tmp workdir", () => {
    expect(
      displaySessionPath("/private/tmp/session-1/workspace", "/tmp/session-1/workspace/file.txt"),
    ).toBe("./file.txt");
  });

  test("leaves external absolute paths unchanged", () => {
    expect(displaySessionPath(workdir, "/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("displayHostPath", () => {
  const workdir = "/Users/test/project";

  test("renders host workdir children relative to the workspace", () => {
    expect(displayHostPath(workdir, "/Users/test/project/src/index.ts", "/Users/test")).toBe(
      "./src/index.ts",
    );
  });

  test("renders host home children relative to ~", () => {
    expect(displayHostPath(workdir, "/Users/test/logs/out.txt", "/Users/test")).toBe(
      "~/logs/out.txt",
    );
  });

  test("handles /private/var alias paths against a /var workdir", () => {
    expect(
      displayHostPath(
        "/var/folders/abc/project",
        "/private/var/folders/abc/project/src/index.ts",
        "/Users/test",
      ),
    ).toBe("./src/index.ts");
  });

  test("does not treat sandbox aliases as host-relative paths", () => {
    expect(
      displayHostPath(
        "/Users/test/project",
        "/home/opencode/workspace/src/index.ts",
        "/Users/test",
      ),
    ).toBe("/home/opencode/workspace/src/index.ts");
  });
});
