import {
  createOpencodeClient,
  type GlobalEvent,
  type OpencodeClient,
  type QuestionAnswer,
} from "@opencode-ai/sdk/v2";
import { Cause, Data, Effect, Exit, Layer, Queue, ServiceMap } from "effect";
import { fileURLToPath } from "node:url";

import { AppConfig, type AppConfigShape } from "@/config.ts";
import { OpencodeEventQueue } from "@/opencode/events.ts";
import { summarizeOpencodeEventForLog, summarizePermissionForLog } from "@/opencode/log-summary.ts";
import {
  buildPromptRequestInput,
  hasIncompletePromptModelOverride,
  resolvePromptModelOverride,
} from "@/opencode/prompt-model.ts";
import { requestData, requestOk, requestTrue } from "@/opencode/request.ts";
import { renderTranscript } from "@/opencode/transcript.ts";
import {
  describeSandboxBackend,
  launchSandboxedServer,
  probeSandboxExecutables,
  stageSandboxConfigDirectory,
  type ResolvedSandboxBackend,
} from "@/sandbox/backend.ts";
import { SANDBOX_WORKSPACE_DIR } from "@/sandbox/session-paths.ts";
import { forkOwned } from "@/util/fork-owned.ts";
import { Logger, type LoggerShape } from "@/util/logging.ts";

export type SessionHandle = {
  sessionId: string;
  client: OpencodeClient;
  workdir: string;
  backend: ResolvedSandboxBackend;
  close: () => Effect.Effect<void>;
};

export type PromptResult = {
  messageId: string;
  transcript: string;
};

type SessionModel = {
  providerID: string;
  modelID: string;
};

export type OpencodeServiceShape = {
  createSession: (
    workdir: string,
    title: string,
    systemPromptAppend?: string,
  ) => Effect.Effect<SessionHandle, unknown>;
  attachSession: (
    workdir: string,
    sessionId: string,
    systemPromptAppend?: string,
  ) => Effect.Effect<SessionHandle, unknown>;
  submitPrompt: (session: SessionHandle, prompt: string) => Effect.Effect<void, unknown>;
  readPromptResult: (
    session: SessionHandle,
    messageId: string,
  ) => Effect.Effect<PromptResult, unknown>;
  interruptSession: (session: SessionHandle) => Effect.Effect<void, unknown>;
  compactSession: (session: SessionHandle) => Effect.Effect<void, unknown>;
  replyToQuestion: (
    session: SessionHandle,
    requestID: string,
    answers: Array<QuestionAnswer>,
  ) => Effect.Effect<void, unknown>;
  rejectQuestion: (session: SessionHandle, requestID: string) => Effect.Effect<void, unknown>;
  isHealthy: (session: SessionHandle) => Effect.Effect<boolean, unknown>;
};

export class OpencodeService extends ServiceMap.Service<OpencodeService, OpencodeServiceShape>()(
  "OpencodeService",
) {}

type OpencodeRuntime = {
  createClient: typeof createOpencodeClient;
  launchServer: typeof launchSandboxedServer;
  probeExecutables: typeof probeSandboxExecutables;
  stageConfigDir: typeof stageSandboxConfigDirectory;
};

const OPENCODE_CONFIG_DIR = fileURLToPath(new URL("../../opencode", import.meta.url));
const defaultRuntime: OpencodeRuntime = {
  createClient: createOpencodeClient,
  launchServer: launchSandboxedServer,
  probeExecutables: probeSandboxExecutables,
  stageConfigDir: stageSandboxConfigDirectory,
};

class OpencodeServiceError extends Data.TaggedError("OpencodeServiceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const formatValue = (value: unknown) => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const isAbortError = (error: unknown) =>
  error instanceof DOMException || (error instanceof Error && error.name === "AbortError");

const opencodeServiceError = (message: string, cause?: unknown) =>
  new OpencodeServiceError({ message, cause });

const consumeEvents = (input: {
  client: OpencodeClient;
  eventQueue: Queue.Queue<GlobalEvent>;
  logger: LoggerShape;
  signal: AbortSignal;
}) =>
  Effect.tryPromise(async () => {
    const events = await input.client.global.event({
      signal: input.signal,
      onSseError: (error) => {
        void Effect.runPromise(
          input.logger.warn("opencode event stream error", {
            error: String(error),
          }),
        );
      },
    });

    for await (const wrapped of events.stream) {
      if (!wrapped || typeof wrapped !== "object" || !("payload" in wrapped)) {
        continue;
      }

      const event = wrapped as GlobalEvent;

      if (
        event.payload.type === "session.status" ||
        event.payload.type === "session.error" ||
        event.payload.type === "session.idle" ||
        event.payload.type === "message.updated" ||
        event.payload.type === "message.part.updated"
      ) {
        await Effect.runPromise(
          input.logger.info("opencode event", summarizeOpencodeEventForLog(event.payload)),
        );
      }

      if (event.payload.type === "permission.asked") {
        const reply = await input.client.permission.reply({
          requestID: event.payload.properties.id,
          reply: "always",
        });
        if (reply.error || reply.data !== true) {
          await Effect.runPromise(
            input.logger.warn("failed to auto-reply to opencode permission request", {
              requestID: event.payload.properties.id,
              permission: summarizePermissionForLog(event.payload.properties),
              error: formatValue(reply.error),
            }),
          );
        }
      }

      await Effect.runPromise(Queue.offer(input.eventQueue, event).pipe(Effect.asVoid));
    }
  });

const isExpectedAbort = (cause: Cause.Cause<unknown>, signal: AbortSignal) =>
  signal.aborted ||
  Cause.hasInterruptsOnly(cause) ||
  cause.reasons.some((reason) => Cause.isFailReason(reason) && isAbortError(reason.error));

const eventStreamEffect = (input: {
  client: OpencodeClient;
  eventQueue: Queue.Queue<GlobalEvent>;
  logger: LoggerShape;
  signal: AbortSignal;
  backend: ResolvedSandboxBackend;
  workdir: string;
}) =>
  consumeEvents(input).pipe(
    Effect.catchCause((cause) =>
      isExpectedAbort(cause, input.signal)
        ? Effect.void
        : input.logger.warn("opencode event stream closed unexpectedly", {
            backend: input.backend,
            workdir: input.workdir,
            error: Cause.pretty(cause),
          }),
    ),
    Effect.asVoid,
  );

const makeSessionCloser =
  (input: {
    abortController: AbortController;
    closeEventStream: () => Effect.Effect<void>;
    closeServer: () => void;
  }) =>
  () =>
    Effect.gen(function* () {
      input.abortController.abort();
      yield* input.closeEventStream();
      yield* Effect.sync(() => {
        input.closeServer();
      });
    });

type SessionBootstrap = {
  server: {
    url: string;
    backend: ResolvedSandboxBackend;
    close: () => void;
  };
  client: OpencodeClient;
  close: () => Effect.Effect<void>;
};

const resolveSessionModel = (session: SessionHandle) =>
  requestData("Failed to load opencode session messages", () =>
    session.client.session.messages({
      sessionID: session.sessionId,
    }),
  ).pipe(
    Effect.flatMap((messages) => {
      let assistantModel: SessionModel | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i]?.info;
        if (!info) {
          continue;
        }
        if (info.role === "user") {
          return Effect.succeed({
            providerID: info.model.providerID,
            modelID: info.model.modelID,
          } satisfies SessionModel);
        }
        if (info.role === "assistant" && !assistantModel) {
          assistantModel = {
            providerID: info.providerID,
            modelID: info.modelID,
          } satisfies SessionModel;
        }
      }

      if (assistantModel) {
        return Effect.succeed(assistantModel);
      }

      return Effect.fail(
        opencodeServiceError(
          "Failed to compact opencode session: no model metadata is available for this session",
        ),
      );
    }),
  );

const loadSessionMessage = (session: SessionHandle, messageId: string) =>
  requestData(`Failed to load opencode message ${messageId}`, () =>
    session.client.session.message({
      sessionID: session.sessionId,
      messageID: messageId,
    }),
  );

const loadPromptResult = (session: SessionHandle, messageId: string) =>
  loadSessionMessage(session, messageId).pipe(
    Effect.map(
      (message) =>
        ({
          messageId,
          transcript: renderTranscript(message.parts),
        }) satisfies PromptResult,
    ),
  );

export const makeOpencodeService = (input: {
  config: AppConfigShape;
  eventQueue: Queue.Queue<GlobalEvent>;
  logger: LoggerShape;
  runtime?: OpencodeRuntime;
}) =>
  Effect.gen(function* () {
    const config = input.config;
    const eventQueue = input.eventQueue;
    const logger = input.logger;
    const runtime = input.runtime ?? defaultRuntime;
    const resolvedBackend = describeSandboxBackend(config.sandboxBackend);
    const executableProbe = yield* Effect.try({
      try: () => runtime.probeExecutables(config),
      catch: (cause) =>
        opencodeServiceError(`Failed to probe sandbox executables: ${formatValue(cause)}`, cause),
    }).pipe(
      Effect.tapError((error) =>
        logger.error("sandbox executable probe failed", {
          configuredBackend: config.sandboxBackend,
          selectedBackend: resolvedBackend,
          error: formatValue(error),
        }),
      ),
    );
    const sandboxConfig = yield* resolvedBackend === "bwrap"
      ? Effect.acquireRelease(
          Effect.promise(() => runtime.stageConfigDir(OPENCODE_CONFIG_DIR)).pipe(
            Effect.tapError((error) =>
              logger.error("failed to stage sandbox config", {
                sourceConfigDir: OPENCODE_CONFIG_DIR,
                error: formatValue(error),
              }),
            ),
          ),
          (config) => Effect.promise(() => config.cleanup()).pipe(Effect.ignore),
        )
      : Effect.succeed({
          configDir: OPENCODE_CONFIG_DIR,
        });
    const launchServer = (workdir: string, systemPromptAppend?: string) =>
      Effect.promise(() =>
        runtime.launchServer({
          config,
          configDir: sandboxConfig.configDir,
          workdir,
          systemPromptAppend,
        }),
      ).pipe(
        Effect.tapError((error) =>
          logger.error("failed to launch opencode server", {
            configuredBackend: config.sandboxBackend,
            selectedBackend: resolvedBackend,
            workdir,
            error: formatValue(error),
          }),
        ),
      );
    const promptModelOverride = resolvePromptModelOverride(config);

    if (hasIncompletePromptModelOverride(config)) {
      yield* logger.warn("ignoring incomplete default model override", {
        hasProviderId: Boolean(config.defaultProviderId),
        hasModelId: Boolean(config.defaultModelId),
      });
    }

    const bootstrapSession = (
      workdir: string,
      systemPromptAppend?: string,
    ): Effect.Effect<SessionBootstrap, unknown> =>
      Effect.gen(function* () {
        const server = yield* launchServer(workdir, systemPromptAppend);
        const clientDirectory = server.backend === "bwrap" ? SANDBOX_WORKSPACE_DIR : workdir;
        const client = runtime.createClient({
          baseUrl: server.url,
          directory: clientDirectory,
        });
        const abortController = new AbortController();
        const closeEventStream = yield* forkOwned(
          eventStreamEffect({
            client,
            eventQueue,
            logger,
            signal: abortController.signal,
            backend: server.backend,
            workdir,
          }),
        );
        const close = makeSessionCloser({
          abortController,
          closeEventStream,
          closeServer: server.close,
        });

        return {
          server,
          client,
          close,
        } satisfies SessionBootstrap;
      });
    const toSessionHandle = (
      bootstrap: SessionBootstrap,
      workdir: string,
      sessionId: string,
    ): SessionHandle => ({
      sessionId,
      client: bootstrap.client,
      workdir,
      backend: bootstrap.server.backend,
      close: bootstrap.close,
    });
    const withBootstrappedSession = <A>(
      workdir: string,
      systemPromptAppend: string | undefined,
      run: (bootstrap: SessionBootstrap) => Effect.Effect<A, unknown>,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const bootstrap = yield* bootstrapSession(workdir, systemPromptAppend);

          return yield* restore(run(bootstrap)).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : bootstrap.close().pipe(Effect.ignore),
            ),
          );
        }),
      );

    yield* logger.info("configured opencode sandbox backend", {
      backend: resolvedBackend,
      configDir: sandboxConfig.configDir,
      opencodeBin: executableProbe.opencodeBin,
      bwrapBin: executableProbe.bwrapBin,
    });

    if (resolvedBackend === "unsafe-dev") {
      yield* logger.warn("opencode sandbox backend is running in unsafe development mode", {
        platform: process.platform,
      });
    }

    return {
      createSession: (workdir, title, systemPromptAppend) =>
        withBootstrappedSession(workdir, systemPromptAppend, (bootstrap) =>
          requestData("Failed to create opencode session", () =>
            bootstrap.client.session.create({ title }),
          ).pipe(
            Effect.tap((session) =>
              logger.info("created opencode session", {
                sessionId: session.id,
                backend: bootstrap.server.backend,
                serverUrl: bootstrap.server.url,
                workdir,
              }),
            ),
            Effect.map((session) => toSessionHandle(bootstrap, workdir, session.id)),
          ),
        ),
      attachSession: (workdir, sessionId, systemPromptAppend) =>
        withBootstrappedSession(workdir, systemPromptAppend, (bootstrap) =>
          requestData("Failed to attach opencode session", () =>
            bootstrap.client.session.get({
              sessionID: sessionId,
            }),
          ).pipe(
            Effect.tap(() =>
              logger.info("attached opencode session", {
                sessionId,
                backend: bootstrap.server.backend,
                serverUrl: bootstrap.server.url,
                workdir,
              }),
            ),
            Effect.as(toSessionHandle(bootstrap, workdir, sessionId)),
          ),
        ),
      submitPrompt: (session, prompt) =>
        requestOk("Failed to prompt opencode", () =>
          session.client.session.promptAsync(
            buildPromptRequestInput(session.sessionId, prompt, promptModelOverride),
          ),
        ),
      readPromptResult: (session, messageId) => loadPromptResult(session, messageId),
      interruptSession: (session) =>
        requestTrue("Failed to interrupt opencode session", () =>
          session.client.session.abort({
            sessionID: session.sessionId,
          }),
        ),
      compactSession: (session) =>
        Effect.gen(function* () {
          const model = yield* resolveSessionModel(session);
          yield* requestTrue("Failed to compact opencode session", () =>
            session.client.session.summarize({
              sessionID: session.sessionId,
              providerID: model.providerID,
              modelID: model.modelID,
            }),
          );
        }),
      replyToQuestion: (session, requestID, answers) =>
        requestTrue("Failed to reply to opencode question", () =>
          session.client.question.reply({
            requestID,
            answers,
          }),
        ),
      rejectQuestion: (session, requestID) =>
        requestTrue("Failed to reject opencode question", () =>
          session.client.question.reject({
            requestID,
          }),
        ),
      isHealthy: (session) =>
        Effect.tryPromise({
          try: () => session.client.global.health(),
          catch: (cause) =>
            opencodeServiceError(
              `Failed to load opencode health status: ${formatValue(cause)}`,
              cause,
            ),
        }).pipe(
          Effect.map((result) => !result.error && result.data?.healthy === true),
          Effect.orElseSucceed(() => false),
        ),
    } satisfies OpencodeServiceShape;
  });

export const OpencodeServiceLayer = Layer.effect(
  OpencodeService,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const eventQueue = yield* OpencodeEventQueue;
    const logger = yield* Logger;
    return yield* makeOpencodeService({
      config,
      eventQueue,
      logger,
    });
  }),
);
