import { Effect, Ref } from "effect";

import type { LoadedSessionHandle } from "@/sessions/session-handle.ts";

type SessionIndexState = {
  handlesByChannelId: Map<string, LoadedSessionHandle>;
  handlesBySessionId: Map<string, LoadedSessionHandle>;
};

export const buildSessionIndex = () =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<SessionIndexState>({
      handlesByChannelId: new Map(),
      handlesBySessionId: new Map(),
    });

    const read = <A>(map: (state: SessionIndexState) => A) =>
      Ref.get(stateRef).pipe(Effect.map(map));
    const update = (f: (state: SessionIndexState) => void) =>
      Ref.update(stateRef, (current) => {
        const next = {
          ...current,
          handlesByChannelId: new Map(current.handlesByChannelId),
          handlesBySessionId: new Map(current.handlesBySessionId),
        };
        f(next);
        return next;
      });

    return {
      updateSession: (
        handle: LoadedSessionHandle,
        options?: {
          previousSessionId?: string;
        },
      ) =>
        Effect.gen(function* () {
          const session = yield* handle.readSession();
          const previousSessionId = options?.previousSessionId ?? session.opencode.sessionId;

          yield* update((state) => {
            state.handlesByChannelId.set(session.channelId, handle);
            state.handlesBySessionId.delete(previousSessionId);
            state.handlesBySessionId.set(session.opencode.sessionId, handle);
          });
        }),
      deleteSession: (handle: LoadedSessionHandle) =>
        handle.readSession().pipe(
          Effect.flatMap((session) =>
            update((state) => {
              state.handlesByChannelId.delete(session.channelId);
              state.handlesBySessionId.delete(session.opencode.sessionId);
            }),
          ),
        ),
      findLoadedHandle: (channelId: string) =>
        read((state) => state.handlesByChannelId.get(channelId)),
      findLoadedHandleBySessionId: (sessionId: string) =>
        read((state) => state.handlesBySessionId.get(sessionId) ?? null),
      findLoadedContextBySessionId: (sessionId: string) =>
        read((state) => state.handlesBySessionId.get(sessionId) ?? null).pipe(
          Effect.flatMap((handle) => (handle ? handle.readContext() : Effect.succeed(null))),
        ),
      findLoadedSession: (channelId: string) =>
        read((state) => state.handlesByChannelId.get(channelId) ?? null).pipe(
          Effect.flatMap((handle) => (handle ? handle.readSession() : Effect.succeed(undefined))),
        ),
      snapshotHandles: () => read((state) => [...state.handlesByChannelId.values()]),
    } as const;
  });

export type SessionIndex = Effect.Success<ReturnType<typeof buildSessionIndex>>;
