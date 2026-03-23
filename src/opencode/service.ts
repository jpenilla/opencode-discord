import {
  createOpencodeClient,
  type GlobalEvent,
  type OpencodeClient,
  type QuestionAnswer,
} from "@opencode-ai/sdk/v2";
import {
  Cause,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Queue,
  Scope,
  ServiceMap,
} from "effect";
import { AppConfig } from "@/config.ts";
import { OpencodeEventQueue } from "@/opencode/events.ts";
import { summarizeOpencodeEventForLog, summarizePermissionForLog } from "@/opencode/log-summary.ts";
import {
  buildPromptRequestInput,
  hasIncompletePromptModelOverride,
  resolvePromptModelOverride,
} from "@/opencode/prompt-model.ts";
import { requestData, requestOk, requestTrue } from "@/opencode/request.ts";
import { renderTranscript } from "@/opencode/transcript/index.ts";
import {
  SandboxBackend,
  type SandboxSession,
  type ResolvedSandboxBackend,
  resolveSandboxBackend,
} from "@/sandbox/common.ts";
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
  ) => Effect.Effect<SessionHandle, unknown, FileSystem.FileSystem | Path.Path>;
  attachSession: (
    workdir: string,
    sessionId: string,
    systemPromptAppend?: string,
  ) => Effect.Effect<SessionHandle, unknown, FileSystem.FileSystem | Path.Path>;
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

export type OpencodeClientFactoryShape = {
  create: typeof createOpencodeClient;
};

export class OpencodeClientFactory extends ServiceMap.Service<
  OpencodeClientFactory,
  OpencodeClientFactoryShape
>()("OpencodeClientFactory") {}

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
    closeSession: () => Effect.Effect<void>;
  }) =>
  () =>
    Effect.gen(function* () {
      input.abortController.abort();
      yield* input.closeEventStream();
      yield* input.closeSession();
    });

type SessionBootstrap = {
  server: SandboxSession;
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

export const makeOpencodeService = Effect.gen(function* () {
  const config = yield* AppConfig;
  const eventQueue = yield* OpencodeEventQueue;
  const logger = yield* Logger;
  const sandboxBackend = yield* SandboxBackend;
  const clientFactory = yield* OpencodeClientFactory;
  const resolvedBackend = resolveSandboxBackend(config.sandboxBackend);
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
  ): Effect.Effect<SessionBootstrap, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      return yield* Effect.gen(function* () {
        const server = yield* sandboxBackend
          .startSession({
            workdir,
            systemPromptAppend,
          })
          .pipe(
            Scope.provide(scope),
            Effect.tapError((error) =>
              logger.error("failed to launch opencode server", {
                configuredBackend: config.sandboxBackend,
                backend: error.backend,
                workdir: error.workdir,
                step: error.step,
                error: error.message,
                cause: formatValue(error.cause),
              }),
            ),
          );
        const client = clientFactory.create({
          baseUrl: server.url,
          directory: server.directory,
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
          closeSession: () => Scope.close(scope, Exit.void),
        });

        return {
          server,
          client,
          close,
        } satisfies SessionBootstrap;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit).pipe(Effect.ignore),
        ),
      );
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

export const OpencodeClientFactoryLayer = Layer.succeed(OpencodeClientFactory, {
  create: createOpencodeClient,
} satisfies OpencodeClientFactoryShape);

export const OpencodeServiceLayer = Layer.effect(OpencodeService, makeOpencodeService).pipe(
  Layer.provideMerge(OpencodeClientFactoryLayer),
);
