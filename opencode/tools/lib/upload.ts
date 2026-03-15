import { basename, resolve } from "node:path";

export const bridgeUploadHeaderName = "x-opencode-discord-upload";

export type BridgeUploadMetadata = {
  sessionID: string;
  filename: string;
  displayPath: string;
  caption?: string;
};

export type BridgeUpload = {
  resolvedPath: string;
  metadata: BridgeUploadMetadata;
};

export const resolveUploadPath = (candidate: string, cwd = process.cwd()) => {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    throw new Error("Path must not be blank");
  }

  return resolve(cwd, trimmed);
};

export const prepareBridgeUpload = (input: {
  sessionID: string;
  path: string;
  caption?: string;
  cwd?: string;
}): BridgeUpload => {
  const displayPath = input.path.trim();
  const resolvedPath = resolveUploadPath(input.path, input.cwd);

  return {
    resolvedPath,
    metadata: {
      sessionID: input.sessionID,
      filename: basename(resolvedPath),
      displayPath,
      ...(input.caption !== undefined ? { caption: input.caption } : {}),
    },
  };
};

export const encodeBridgeUploadMetadata = (metadata: BridgeUploadMetadata) => {
  return Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
};
