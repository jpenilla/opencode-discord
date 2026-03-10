import { join, resolve } from "node:path";

export type StatePaths = {
  rootDir: string;
  dbPath: string;
  sessionsRootDir: string;
};

export const resolveStatePaths = (stateDir: string): StatePaths => {
  const rootDir = resolve(stateDir);
  return {
    rootDir,
    dbPath: join(rootDir, "state.sqlite"),
    sessionsRootDir: join(rootDir, "sessions"),
  };
};

export const sessionRootDir = (sessionsRootDir: string, channelId: string) =>
  join(sessionsRootDir, channelId);

export const sessionWorkdirFromRoot = (rootDir: string) => join(rootDir, "home", "workspace");
