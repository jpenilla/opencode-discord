export type SessionActivity = {
  hasActiveRun: boolean;
  hasPendingQuestions: boolean;
  hasIdleCompaction: boolean;
  hasQueuedWork: boolean;
  isBusy: boolean;
};

export type ChannelActivity = { type: "missing" } | { type: "present"; activity: SessionActivity };
