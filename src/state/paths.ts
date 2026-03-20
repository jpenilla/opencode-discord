import path from "node:path";

export type StatePaths = {
  rootDir: string;
  dbPath: string;
  sessionsRootDir: string;
};

export type SessionPaths = {
  rootDir: string;
  workdir: string;
};

export const resolveStatePaths = (stateDir: string): StatePaths => {
  const rootDir = path.resolve(stateDir);
  return {
    rootDir,
    dbPath: path.join(rootDir, "state.sqlite"),
    sessionsRootDir: path.join(rootDir, "sessions"),
  };
};

export const sessionRootDir = (sessionsRootDir: string, channelId: string) =>
  path.join(sessionsRootDir, channelId);

export const sessionWorkdirFromRoot = (rootDir: string) => path.join(rootDir, "home", "workspace");

export const sessionPathsFromRoot = (rootDir: string): SessionPaths => ({
  rootDir,
  workdir: sessionWorkdirFromRoot(rootDir),
});

export const sessionPathsForChannel = (sessionsRootDir: string, channelId: string): SessionPaths =>
  sessionPathsFromRoot(sessionRootDir(sessionsRootDir, channelId));
