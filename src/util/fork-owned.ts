import { Effect, Exit, Scope } from "effect";

export const forkOwned = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<() => Effect.Effect<void>, never, R> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    yield* effect.pipe(Effect.forkIn(scope, { startImmediately: true }));
    return () => Scope.close(scope, Exit.void);
  });
