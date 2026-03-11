import {
  createOpencodeClient,
  type GlobalEvent,
  type OpencodeClient,
  type QuestionAnswer,
} from "@opencode-ai/sdk/v2";
import { Cause, Chunk, Context, Effect, Fiber, Layer } from "effect";
import { fileURLToPath } from "node:url";

import { AppConfig } from "@/config.ts";
import { OpencodeEventQueue, type OpencodeEventQueueShape } from "@/opencode/events.ts";
import {
  buildPromptRequestInput,
  hasIncompletePromptModelOverride,
  resolvePromptModelOverride,
} from "@/opencode/prompt-model.ts";
import { renderTranscript } from "@/opencode/transcript.ts";
import {
  describeSandboxBackend,
  launchSandboxedServer,
  probeSandboxExecutables,
  stageSandboxConfigDirectory,
  type ResolvedSandboxBackend,
} from "@/sandbox/backend.ts";
import { SANDBOX_WORKSPACE_DIR } from "@/sandbox/session-paths.ts";
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

export class OpencodeService extends Context.Tag("OpencodeService")<
  OpencodeService,
  OpencodeServiceShape
>() {}

const OPENCODE_CONFIG_DIR = fileURLToPath(new URL("../../opencode", import.meta.url));

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

const consumeEvents = (input: {
  client: OpencodeClient;
  eventQueue: OpencodeEventQueueShape;
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
          input.logger.info("opencode event", {
            type: event.payload.type,
            properties: event.payload.properties,
          }),
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
              permission: event.payload.properties.permission,
              error: formatValue(reply.error),
            }),
          );
        }
      }

      await Effect.runPromise(input.eventQueue.publish(event));
    }
  });

const isExpectedAbort = (cause: Cause.Cause<unknown>, signal: AbortSignal) =>
  signal.aborted ||
  Cause.isInterruptedOnly(cause) ||
  Chunk.toReadonlyArray(Cause.failures(cause)).some(
    (error: unknown) =>
      error instanceof DOMException || (error instanceof Error && error.name === "AbortError"),
  );

const forkEventStream = (input: {
  client: OpencodeClient;
  eventQueue: OpencodeEventQueueShape;
  logger: LoggerShape;
  signal: AbortSignal;
  backend: ResolvedSandboxBackend;
  workdir: string;
}) =>
  consumeEvents(input).pipe(
    Effect.tapErrorCause((cause) =>
      isExpectedAbort(cause, input.signal)
        ? Effect.void
        : input.logger.warn("opencode event stream closed unexpectedly", {
            backend: input.backend,
            workdir: input.workdir,
            error: Cause.pretty(cause),
          }),
    ),
    Effect.ignore,
    Effect.fork,
  );

const makeSessionCloser =
  (input: {
    abortController: AbortController;
    eventFiber: Fiber.RuntimeFiber<void, never>;
    closeServer: () => void;
  }) =>
  () =>
    Effect.gen(function* () {
      input.abortController.abort();
      yield* Fiber.interrupt(input.eventFiber);
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
  Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      session.client.session.messages({
        sessionID: session.sessionId,
      }),
    );

    if (result.error || !result.data) {
      throw new Error(`Failed to load opencode session messages: ${formatValue(result.error)}`);
    }

    let assistantModel: SessionModel | null = null;
    for (let i = result.data.length - 1; i >= 0; i--) {
      const info = result.data[i]?.info;
      if (!info) {
        continue;
      }
      if (info.role === "user") {
        return {
          providerID: info.model.providerID,
          modelID: info.model.modelID,
        } satisfies SessionModel;
      }
      if (info.role === "assistant" && !assistantModel) {
        assistantModel = {
          providerID: info.providerID,
          modelID: info.modelID,
        } satisfies SessionModel;
      }
    }

    if (assistantModel) {
      return assistantModel;
    }

    throw new Error(
      "Failed to compact opencode session: no model metadata is available for this session",
    );
  });

const loadSessionMessage = (session: SessionHandle, messageId: string) =>
  Effect.promise(() =>
    session.client.session.message({
      sessionID: session.sessionId,
      messageID: messageId,
    }),
  ).pipe(
    Effect.map((result) => {
      if (result.error || !result.data) {
        throw new Error(
          `Failed to load opencode message ${messageId}: ${formatValue(result.error)}`,
        );
      }

      return result.data;
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

export const OpencodeServiceLive = Layer.scoped(
  OpencodeService,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const eventQueue = yield* OpencodeEventQueue;
    const logger = yield* Logger;
    const resolvedBackend = describeSandboxBackend(config.sandboxBackend);
    const executableProbe = yield* Effect.try({
      try: () => probeSandboxExecutables(config),
      catch: (error) => error,
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
          Effect.promise(() => stageSandboxConfigDirectory(OPENCODE_CONFIG_DIR)).pipe(
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
        launchSandboxedServer({
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
        const client = createOpencodeClient({
          baseUrl: server.url,
          directory: clientDirectory,
        });
        const abortController = new AbortController();
        const eventFiber = yield* forkEventStream({
          client,
          eventQueue,
          logger,
          signal: abortController.signal,
          backend: server.backend,
          workdir,
        });
        const close = makeSessionCloser({
          abortController,
          eventFiber,
          closeServer: server.close,
        });

        return {
          server,
          client,
          close,
        } satisfies SessionBootstrap;
      });

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
        Effect.gen(function* () {
          const bootstrap = yield* bootstrapSession(workdir, systemPromptAppend);

          try {
            const result = yield* Effect.promise(() => bootstrap.client.session.create({ title }));
            if (result.error || !result.data) {
              throw new Error(`Failed to create opencode session: ${formatValue(result.error)}`);
            }

            yield* logger.info("created opencode session", {
              sessionId: result.data.id,
              backend: bootstrap.server.backend,
              serverUrl: bootstrap.server.url,
              workdir,
            });

            return {
              sessionId: result.data.id,
              client: bootstrap.client,
              workdir,
              backend: bootstrap.server.backend,
              close: bootstrap.close,
            } satisfies SessionHandle;
          } catch (error) {
            yield* bootstrap.close().pipe(Effect.ignore);
            throw error;
          }
        }),
      attachSession: (workdir, sessionId, systemPromptAppend) =>
        Effect.gen(function* () {
          const bootstrap = yield* bootstrapSession(workdir, systemPromptAppend);

          try {
            const result = yield* Effect.promise(() =>
              bootstrap.client.session.get({
                sessionID: sessionId,
              }),
            );

            if (result.error || !result.data) {
              throw new Error(`Failed to attach opencode session: ${formatValue(result.error)}`);
            }

            yield* logger.info("attached opencode session", {
              sessionId,
              backend: bootstrap.server.backend,
              serverUrl: bootstrap.server.url,
              workdir,
            });

            return {
              sessionId,
              client: bootstrap.client,
              workdir,
              backend: bootstrap.server.backend,
              close: bootstrap.close,
            } satisfies SessionHandle;
          } catch (error) {
            yield* bootstrap.close().pipe(Effect.ignore);
            throw error;
          }
        }),
      submitPrompt: (session, prompt) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            session.client.session.promptAsync(
              buildPromptRequestInput(session.sessionId, prompt, promptModelOverride),
            ),
          );

          if (result.error) {
            throw new Error(`Failed to prompt opencode: ${formatValue(result.error)}`);
          }
        }),
      readPromptResult: (session, messageId) => loadPromptResult(session, messageId),
      interruptSession: (session) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            session.client.session.abort({
              sessionID: session.sessionId,
            }),
          );

          if (result.error || result.data !== true) {
            throw new Error(`Failed to interrupt opencode session: ${formatValue(result.error)}`);
          }
        }),
      compactSession: (session) =>
        Effect.gen(function* () {
          const model = yield* resolveSessionModel(session);
          const result = yield* Effect.promise(() =>
            session.client.session.summarize({
              sessionID: session.sessionId,
              providerID: model.providerID,
              modelID: model.modelID,
            }),
          );

          if (result.error || result.data !== true) {
            throw new Error(`Failed to compact opencode session: ${formatValue(result.error)}`);
          }
        }),
      replyToQuestion: (session, requestID, answers) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            session.client.question.reply({
              requestID,
              answers,
            }),
          );

          if (result.error || result.data !== true) {
            throw new Error(`Failed to reply to opencode question: ${formatValue(result.error)}`);
          }
        }),
      rejectQuestion: (session, requestID) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            session.client.question.reject({
              requestID,
            }),
          );

          if (result.error || result.data !== true) {
            throw new Error(`Failed to reject opencode question: ${formatValue(result.error)}`);
          }
        }),
      isHealthy: (session) =>
        Effect.promise(() => session.client.global.health()).pipe(
          Effect.map((result) => !result.error && result.data?.healthy === true),
          Effect.orElseSucceed(() => false),
        ),
    } satisfies OpencodeServiceShape;
  }),
);
