import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export type BridgeUploadPayload = {
  sessionID: string;
  filename: string;
  displayPath: string;
  dataBase64: string;
  caption?: string;
};

export const resolveUploadPath = (candidate: string, cwd = process.cwd()) => {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    throw new Error("Path must not be blank");
  }

  return resolve(cwd, trimmed);
};

export const buildBridgeUploadPayload = async (input: {
  sessionID: string;
  path: string;
  caption?: string;
  cwd?: string;
}): Promise<BridgeUploadPayload> => {
  const displayPath = input.path.trim();
  const resolvedPath = resolveUploadPath(input.path, input.cwd);
  const data = await readFile(resolvedPath);

  return {
    sessionID: input.sessionID,
    filename: basename(resolvedPath),
    displayPath,
    dataBase64: data.toString("base64"),
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
  };
};
