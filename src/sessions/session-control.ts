import type { SendableChannels } from "discord.js";
import { Effect, Queue, ServiceMap } from "effect";

import type { ActiveRun, ChannelSession } from "@/sessions/session.ts";
import type { ChannelSettings } from "@/state/channel-settings.ts";

export type SessionControlShape = {
  getLoaded: (channelId: string) => Effect.Effect<ChannelSession | null, unknown>;
  getOrRestore: (channelId: string) => Effect.Effect<ChannelSession | null, unknown>;
  invalidate: (channelId: string, reason: string) => Effect.Effect<void, unknown>;
  attachProgressChannel: (
    session: ChannelSession,
    channel: SendableChannels,
  ) => Effect.Effect<void>;
  hasQueuedWork: (session: ChannelSession) => Effect.Effect<boolean, unknown>;
  setChannelSettings: (session: ChannelSession, settings: ChannelSettings) => Effect.Effect<void>;
  setRunInterruptRequested: (activeRun: ActiveRun, requested: boolean) => Effect.Effect<void>;
};

export class SessionControl extends ServiceMap.Service<SessionControl, SessionControlShape>()(
  "SessionControl",
) {}

export const makeSessionControl = (deps: {
  getLoaded: SessionControlShape["getLoaded"];
  getOrRestore: SessionControlShape["getOrRestore"];
  invalidate: SessionControlShape["invalidate"];
}): SessionControlShape => ({
  getLoaded: deps.getLoaded,
  getOrRestore: deps.getOrRestore,
  invalidate: deps.invalidate,
  attachProgressChannel: (session, channel) =>
    Effect.sync(() => {
      session.progressChannel = channel;
    }),
  hasQueuedWork: (session) => Queue.size(session.queue).pipe(Effect.map((size) => size > 0)),
  setChannelSettings: (session, settings) =>
    Effect.sync(() => {
      session.channelSettings = settings;
    }),
  setRunInterruptRequested: (activeRun, requested) =>
    Effect.sync(() => {
      activeRun.interruptRequested = requested;
    }),
});
