import {
  Config,
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  ServiceMap,
} from "effect";

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

export class AppConfig extends ServiceMap.Service<AppConfig, AppConfigShape>()("AppConfig") {}

const defaultToolBridgeSocketPath = () =>
  `/tmp/opencode-discord-${process.pid}-${crypto.randomUUID().slice(0, 8)}/bridge.sock`;

const positiveInteger = (name: string, fallback: number) =>
  Config.withDefault(
    Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), name),
    fallback,
  );

const stringList = (name: string) =>
  Config.withDefault(Config.schema(Schema.Array(Schema.String), name), [] as Array<string>);

const optionalString = (name: string) =>
  Config.map(Config.option(Config.string(name)), (value) =>
    Option.match(value, {
      onNone: () => undefined,
      onSome: (entry) => entry,
    }),
  );

const nonEmptyRedacted = (name: string) =>
  Config.map(Config.nonEmptyString(name), (value) => Redacted.make(value));

const AppConfigSource = Config.all({
  discordToken: nonEmptyRedacted("discordToken"),
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
  toolBridgeSocketPath: Config.string("discordToolBridgeSocket").pipe(
    Config.orElse(() => Config.succeed(defaultToolBridgeSocketPath())),
  ),
  sandboxBackend: Config.withDefault(
    Config.schema(Schema.Literals(["auto", "unsafe-dev", "bwrap"]), "sandboxBackend"),
    "auto",
  ),
  opencodeBin: Config.withDefault(Config.string("opencodeBin"), "opencode"),
  bwrapBin: Config.withDefault(Config.string("bwrapBin"), "bwrap"),
  sandboxReadOnlyPaths: stringList("sandboxReadOnlyPaths"),
  sandboxEnvPassthrough: stringList("sandboxEnvPassthrough"),
});

export const parseAppConfig = (
  provider = ConfigProvider.fromEnv().pipe(ConfigProvider.constantCase),
) =>
  AppConfigSource.parse(provider).pipe(
    Effect.map((config) => ({
      ...config,
      toolBridgeToken: Redacted.make(crypto.randomUUID()),
    })),
  );

export const AppConfigLayer = Layer.effect(
  AppConfig,
  parseAppConfig(),
);
