import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Option } from "effect";

import { forkOwned } from "@/util/fork-owned.ts";

describe("forkOwned", () => {
  test("keeps the background effect alive until the explicit close runs", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const stopped = await Effect.runPromise(Deferred.make<void>());

    const close = await Effect.runPromise(
      forkOwned(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(stopped, undefined).pipe(Effect.ignore)),
        ),
      ),
    );

    await Effect.runPromise(Deferred.await(started));
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(stopped)))).toBe(true);

    await Effect.runPromise(close());
    expect(Option.isSome(await Effect.runPromise(Deferred.poll(stopped)))).toBe(true);
  });
});
