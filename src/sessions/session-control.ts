import type { SendableChannels } from "discord.js";
import { Effect, Queue, ServiceMap } from "effect";

import type { ActiveRun, ChannelSession, RunInterruptSource } from "@/sessions/session.ts";
import type { ChannelSettings } from "@/state/channel-settings.ts";

export type SessionControlShape = {
  getLoaded: (channelId: string) => Effect.Effect<ChannelSession | null, unknown>;
  getOrRestore: (channelId: string) => Effect.Effect<ChannelSession | null, unknown>;
  invalidate: (channelId: string, reason: string) => Effect.Effect<boolean, unknown>;
  isSessionBusy: (session: ChannelSession) => Effect.Effect<boolean, unknown>;
  hasPendingQuestions: (sessionId: string) => Effect.Effect<boolean, unknown>;
  attachProgressChannel: (
    session: ChannelSession,
    channel: SendableChannels,
  ) => Effect.Effect<void>;
  hasQueuedWork: (session: ChannelSession) => Effect.Effect<boolean, unknown>;
  setChannelSettings: (session: ChannelSession, settings: ChannelSettings) => Effect.Effect<void>;
  setRunInterruptRequested: (
    activeRun: ActiveRun,
    requested: boolean,
    source?: RunInterruptSource | null,
  ) => Effect.Effect<void>;
};

export class SessionControl extends ServiceMap.Service<SessionControl, SessionControlShape>()(
  "SessionControl",
) {}

export const makeSessionControl = (deps: {
  getLoaded: SessionControlShape["getLoaded"];
  getOrRestore: SessionControlShape["getOrRestore"];
  invalidate: SessionControlShape["invalidate"];
  isSessionBusy: SessionControlShape["isSessionBusy"];
  hasPendingQuestions: SessionControlShape["hasPendingQuestions"];
}): SessionControlShape => ({
  getLoaded: deps.getLoaded,
  getOrRestore: deps.getOrRestore,
  invalidate: deps.invalidate,
  isSessionBusy: deps.isSessionBusy,
  hasPendingQuestions: deps.hasPendingQuestions,
  attachProgressChannel: (session, channel) =>
    Effect.sync(() => {
      session.progressChannel = channel;
    }),
  hasQueuedWork: (session) => Queue.size(session.queue).pipe(Effect.map((size) => size > 0)),
  setChannelSettings: (session, settings) =>
    Effect.sync(() => {
      session.channelSettings = settings;
    }),
  setRunInterruptRequested: (activeRun, requested, source = requested ? "user" : null) =>
    Effect.sync(() => {
      activeRun.interruptRequested = requested;
      activeRun.interruptSource = requested ? source : null;
    }),
});
