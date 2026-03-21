import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Exit, Fiber, Queue, Ref, Scope } from "effect";

export const runTestEffect = <A, E = never, R = never>(
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)) as Effect.Effect<A, E, never>);

export const closeTestScope = (scope: Scope.Closeable) =>
  runTestEffect(Scope.close(scope, Exit.void));

export const appendRef = <A>(ref: Ref.Ref<Array<A>>, value: A) =>
  Ref.update(ref, (current) => [...current, value]);

export const makeRef = <A>(value: A) => runTestEffect(Ref.make(value));

export const readRef = <A>(ref: Ref.Ref<A>) => runTestEffect(Ref.get(ref));

export const makeDeferred = <A = void, E = never>() => runTestEffect(Deferred.make<A, E>());

export const updateMapRef = <K, V>(ref: Ref.Ref<Map<K, V>>, update: (current: Map<K, V>) => void) =>
  Ref.update(ref, (current) => {
    const next = new Map(current);
    update(next);
    return next;
  });

export const takeAll = <A>(queue: Queue.Dequeue<A>) => runTestEffect(Queue.takeAll(queue));

export const clearQueue = <A>(queue: Queue.Dequeue<A>) => runTestEffect(Queue.clear(queue));

export const runConcurrent = <A, E1, R1, B, E2, R2>(
  first: Effect.Effect<A, E1, R1>,
  second: Effect.Effect<B, E2, R2>,
) =>
  runTestEffect(
    Effect.gen(function* () {
      const firstFiber = yield* Effect.forkChild(first);
      const secondFiber = yield* Effect.forkChild(second);
      return yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)]);
    }),
  );
