import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { DiscordBot, DiscordBotLive } from "@/app.ts";
import { AppConfigLive } from "@/config.ts";
import { OpencodeEventQueueLive } from "@/opencode/events.ts";
import { OpencodeServiceLive } from "@/opencode/service.ts";
import { ChannelSessionsLive } from "@/sessions/registry.ts";
import { SessionStoreLive } from "@/state/store.ts";
import { ToolBridgeLive } from "@/tools/http.ts";
import { Logger, LoggerLive } from "@/util/logging.ts";

const BaseLive = Layer.mergeAll(AppConfigLive, LoggerLive, OpencodeEventQueueLive);

const OpencodeLive = OpencodeServiceLive.pipe(Layer.provide(BaseLive));
const StateLive = SessionStoreLive.pipe(Layer.provide(AppConfigLive));
const SessionsDeps = Layer.mergeAll(BaseLive, OpencodeLive, StateLive);
const SessionsLive = ChannelSessionsLive.pipe(Layer.provide(SessionsDeps));
const ToolBridgeDeps = Layer.mergeAll(BaseLive, SessionsLive);
const ToolBridgeReady = ToolBridgeLive.pipe(Layer.provide(ToolBridgeDeps));
const DiscordReady = DiscordBotLive.pipe(Layer.provide(ToolBridgeDeps));

const Live = Layer.mergeAll(BaseLive, OpencodeLive, SessionsLive, ToolBridgeReady, DiscordReady);

const program = Effect.gen(function* () {
  const logger = yield* Logger;
  yield* DiscordBot;
  yield* logger.info("application started");
  yield* Effect.never;
});

BunRuntime.runMain(program.pipe(Effect.provide(Live)));
