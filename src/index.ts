import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { DiscordBotLayer } from "@/app.ts";
import { AppConfigLayer } from "@/config.ts";
import { OpencodeEventQueueLayer } from "@/opencode/events.ts";
import { OpencodeServiceLayer } from "@/opencode/service.ts";
import { ChannelSessionsLayer } from "@/sessions/registry.ts";
import { SessionStoreLayer } from "@/state/store.ts";
import { ToolBridgeLayer } from "@/tools/bridge/server.ts";
import { Logger, LoggerLayer } from "@/util/logging.ts";

const baseLayer = Layer.mergeAll(AppConfigLayer, LoggerLayer, OpencodeEventQueueLayer);

const opencodeLayer = OpencodeServiceLayer.pipe(Layer.provide(baseLayer));
const sessionStoreLayer = SessionStoreLayer.pipe(Layer.provide(AppConfigLayer));
const sessionsDependenciesLayer = Layer.mergeAll(baseLayer, opencodeLayer, sessionStoreLayer);
const channelSessionsLayer = ChannelSessionsLayer.pipe(Layer.provide(sessionsDependenciesLayer));
const startupDependenciesLayer = Layer.mergeAll(baseLayer, channelSessionsLayer);
const toolBridgeLayer = ToolBridgeLayer.pipe(Layer.provide(startupDependenciesLayer));
const discordBotLayer = DiscordBotLayer.pipe(Layer.provide(startupDependenciesLayer));

const appLayer = Layer.mergeAll(
  baseLayer,
  opencodeLayer,
  channelSessionsLayer,
  toolBridgeLayer,
  discordBotLayer,
);

const program = Effect.gen(function* () {
  const logger = yield* Logger;
  yield* logger.info("application started");
  yield* Effect.never;
});

BunRuntime.runMain(program.pipe(Effect.provide(appLayer)));
