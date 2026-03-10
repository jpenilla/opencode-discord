import { Effect } from "effect";

// Centralize structural test doubles for large external interfaces.
export const unsafeStub = <T>(value: unknown): T => value as T;
export const unsafeEffect = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
  effect as Effect.Effect<A>;
