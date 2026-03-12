import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted } from "effect";

export type AppConfigShape = {
  discordToken: Redacted.Redacted<string>;
  triggerPhrase: string;
  ignoreOtherBotTriggers: boolean;
  sessionInstructions: string;
  stateDir: string;
  defaultProviderId?: string;
  defaultModelId?: string;
  showThinkingByDefault: boolean;
  showCompactionSummariesByDefault: boolean;
  sessionIdleTimeoutMs: number;
  toolBridgeSocketPath: string;
  toolBridgeToken: Redacted.Redacted<string>;
  sandboxBackend: "auto" | "unsafe-dev" | "bwrap";
  opencodeBin: string;
  bwrapBin: string;
  sandboxReadOnlyPaths: ReadonlyArray<string>;
  sandboxEnvPassthrough: ReadonlyArray<string>;
};

export class AppConfig extends Context.Tag("AppConfig")<AppConfig, AppConfigShape>() {}

const defaultToolBridgeSocketPath = () =>
  `/tmp/opencode-discord-${process.pid}-${crypto.randomUUID().slice(0, 8)}/bridge.sock`;

const positiveInteger = (name: string, fallback: number) =>
  Config.withDefault(
    Config.validate(Config.integer(name), {
      message: `${name} must be a positive integer`,
      validation: (value) => value > 0,
    }),
    fallback,
  );

const stringList = (name: string) =>
  Config.withDefault(Config.array(Config.string(), name), [] as Array<string>);

const optionalString = (name: string) =>
  Config.map(Config.option(Config.string(name)), (value) =>
    Option.match(value, {
      onNone: () => undefined,
      onSome: (entry) => entry,
    }),
  );

const AppConfigSource: Config.Config<AppConfigShape> = Config.all({
  discordToken: Config.redacted(Config.nonEmptyString("discordToken")),
  triggerPhrase: Config.withDefault(Config.string("triggerPhrase"), "hey opencode"),
  ignoreOtherBotTriggers: Config.withDefault(Config.boolean("ignoreOtherBotTriggers"), false),
  sessionInstructions: Config.withDefault(Config.string("sessionInstructions"), ""),
  stateDir: Config.withDefault(Config.string("stateDir"), "./storage"),
  defaultProviderId: optionalString("defaultProviderId"),
  defaultModelId: optionalString("defaultModelId"),
  showThinkingByDefault: Config.withDefault(Config.boolean("showThinkingByDefault"), true),
  showCompactionSummariesByDefault: Config.withDefault(
    Config.boolean("showCompactionSummariesByDefault"),
    true,
  ),
  sessionIdleTimeoutMs: positiveInteger("sessionIdleTimeoutMs", 30 * 60 * 1_000),
  toolBridgeSocketPath: Config.orElse(Config.string("discordToolBridgeSocket"), () =>
    Config.sync(defaultToolBridgeSocketPath),
  ),
  toolBridgeToken: Config.redacted(Config.sync(() => crypto.randomUUID())),
  sandboxBackend: Config.withDefault(
    Config.literal("auto", "unsafe-dev", "bwrap")("sandboxBackend"),
    "auto",
  ),
  opencodeBin: Config.withDefault(Config.string("opencodeBin"), "opencode"),
  bwrapBin: Config.withDefault(Config.string("bwrapBin"), "bwrap"),
  sandboxReadOnlyPaths: stringList("sandboxReadOnlyPaths"),
  sandboxEnvPassthrough: stringList("sandboxEnvPassthrough"),
});

export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.withConfigProvider(AppConfigSource, ConfigProvider.constantCase(ConfigProvider.fromEnv())),
);
