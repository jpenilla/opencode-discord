import { BunRuntime } from "@effect/platform-bun";
import { Deferred, Effect, Layer } from "effect";

import { DiscordBotLayer } from "@/app.ts";
import { ChannelRuntime, ChannelRuntimeLayer } from "@/channels/channel-runtime.ts";
import { AppConfigLayer } from "@/config.ts";
import { OpencodeEventQueueLayer } from "@/opencode/events.ts";
import { OpencodeServiceLayer } from "@/opencode/service.ts";
import { installShutdownSignalHandlers } from "@/shutdown/signals.ts";
import { SessionStoreLayer } from "@/state/store.ts";
import { ToolBridgeLayer } from "@/tools/bridge/server.ts";
import { Logger, LoggerLayer } from "@/util/logging.ts";

const baseLayer = Layer.mergeAll(AppConfigLayer, LoggerLayer, OpencodeEventQueueLayer);

const opencodeLayer = OpencodeServiceLayer.pipe(Layer.provide(baseLayer));
const sessionStoreLayer = SessionStoreLayer.pipe(Layer.provide(AppConfigLayer));
const sessionsDependenciesLayer = Layer.mergeAll(baseLayer, opencodeLayer, sessionStoreLayer);
const channelRuntimeLayer = ChannelRuntimeLayer.pipe(Layer.provide(sessionsDependenciesLayer));
const startupDependenciesLayer = Layer.mergeAll(baseLayer, channelRuntimeLayer);
const toolBridgeLayer = ToolBridgeLayer.pipe(Layer.provide(startupDependenciesLayer));
const discordBotLayer = DiscordBotLayer.pipe(Layer.provide(startupDependenciesLayer));

const appLayer = Layer.mergeAll(
  baseLayer,
  opencodeLayer,
  channelRuntimeLayer,
  toolBridgeLayer,
  discordBotLayer,
);

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
