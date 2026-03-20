import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Ref, Scope } from "effect";

export const runTestEffect = <A, E = never, R = never>(
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)) as Effect.Effect<A, E, never>);

export const closeTestScope = (scope: Scope.Closeable) =>
  runTestEffect(Scope.close(scope, Exit.void));

export const appendRef = <A>(ref: Ref.Ref<Array<A>>, value: A) =>
  Ref.update(ref, (current) => [...current, value]);
