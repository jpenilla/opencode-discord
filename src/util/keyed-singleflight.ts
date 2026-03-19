import { Deferred, Effect, Exit } from "effect";

export type KeyedSingleflight<K> = {
  run: <A, E, R>(
    key: K,
    task: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  waitAndRetry: <A, E, R>(key: K, task: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

export const createKeyedSingleflight = <K>(): KeyedSingleflight<K> => {
  const resultGates = new Map<K, Deferred.Deferred<unknown, unknown>>();
  const completionGates = new Map<K, Deferred.Deferred<void, never>>();

  const singleflight: KeyedSingleflight<K> = {
    run: <A, E, R>(key: K, task: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<A, E>();
          const existing = yield* Effect.sync(() => {
            const current = resultGates.get(key) as Deferred.Deferred<A, E> | undefined;
            if (!current) {
              resultGates.set(key, gate as Deferred.Deferred<unknown, unknown>);
            }
            return current;
          });
          if (existing) {
            return yield* Deferred.await(existing);
          }

          const exit = yield* restore(task).pipe(Effect.exit);
          yield* Effect.sync(() => {
            if (resultGates.get(key) === gate) {
              resultGates.delete(key);
            }
          });
          yield* Deferred.done(gate, exit).pipe(Effect.ignore);
          return yield* Exit.match(exit, {
            onSuccess: Effect.succeed,
            onFailure: Effect.failCause,
          });
        }),
      ),
    waitAndRetry: <A, E, R>(key: K, task: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void, never>();
          const existing = yield* Effect.sync(() => {
            const current = completionGates.get(key);
            if (!current) {
              completionGates.set(key, gate);
            }
            return current;
          });
          if (existing) {
            yield* Deferred.await(existing);
            return yield* singleflight.waitAndRetry(key, task);
          }

          const exit = yield* restore(task).pipe(Effect.exit);
          yield* Effect.sync(() => {
            if (completionGates.get(key) === gate) {
              completionGates.delete(key);
            }
          });
          yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore);
          return yield* Exit.match(exit, {
            onSuccess: Effect.succeed,
            onFailure: Effect.failCause,
          });
        }),
      ),
  };

  return singleflight;
};
