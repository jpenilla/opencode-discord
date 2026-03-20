import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Layer } from "effect";

import { DiscordBotLayer } from "@/app.ts";
import { ChannelRuntime, ChannelRuntimeLayer } from "@/channels/channel-runtime.ts";
import { AppConfigLayer } from "@/config.ts";
import { InfoCardsLayer } from "@/discord/info-card.ts";
import { OpencodeEventQueueLayer } from "@/opencode/events.ts";
import { OpencodeServiceLayer } from "@/opencode/service.ts";
import { SandboxBackendLayer } from "@/sandbox/backend.ts";
import { SessionRuntimeLayer } from "@/sessions/session-runtime.ts";
import { installShutdownSignalHandlers } from "@/shutdown/signals.ts";
import { StatePersistenceLayer } from "@/state/persistence.ts";
import { ToolBridgeLayer } from "@/tools/bridge/server.ts";
import { Logger, LoggerLayer } from "@/util/logging.ts";

const baseLayer = Layer.mergeAll(AppConfigLayer, LoggerLayer, OpencodeEventQueueLayer);
const sandboxLayer = SandboxBackendLayer.pipe(Layer.provide(AppConfigLayer));
const opencodeLayer = OpencodeServiceLayer.pipe(
  Layer.provide(Layer.mergeAll(baseLayer, sandboxLayer)),
);
const statePersistenceLayer = StatePersistenceLayer.pipe(Layer.provide(AppConfigLayer));
const sessionRuntimeLayer = SessionRuntimeLayer.pipe(
  Layer.provide(Layer.mergeAll(baseLayer, InfoCardsLayer, opencodeLayer, statePersistenceLayer)),
);
const channelRuntimeLayer = ChannelRuntimeLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      baseLayer,
      InfoCardsLayer,
      opencodeLayer,
      statePersistenceLayer,
      sessionRuntimeLayer,
    ),
  ),
);

const appLayer = Layer.mergeAll(
  baseLayer,
  sandboxLayer,
  InfoCardsLayer,
  opencodeLayer,
  statePersistenceLayer,
  sessionRuntimeLayer,
  channelRuntimeLayer,
  ToolBridgeLayer.pipe(Layer.provide(Layer.mergeAll(baseLayer, sessionRuntimeLayer))),
  DiscordBotLayer.pipe(Layer.provide(Layer.mergeAll(baseLayer, channelRuntimeLayer))),
).pipe(Layer.provideMerge(BunServices.layer));

const program = Effect.gen(function* () {
  const logger = yield* Logger;
  const channels = yield* ChannelRuntime;
  const shutdownRequested = yield* Deferred.make<void>();
  const removeSignalHandlers = installShutdownSignalHandlers({
    target: process,
    onFirstSignal: (signal) => {
      void Effect.runPromise(
        logger.warn("graceful shutdown requested", {
          signal,
        }),
      );
      void Effect.runPromise(Deferred.succeed(shutdownRequested, undefined).pipe(Effect.ignore));
    },
    onSecondSignal: (signal) => {
      void Effect.runPromise(
        logger.warn("forcing process exit during shutdown", {
          signal,
        }),
      );
      process.exit(130);
    },
  });

  yield* Effect.gen(function* () {
    yield* logger.info("application started");
    yield* Deferred.await(shutdownRequested);
    yield* channels.shutdown();
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        removeSignalHandlers();
      }),
    ),
  );
});

BunRuntime.runMain(program.pipe(Effect.provide(appLayer)));
