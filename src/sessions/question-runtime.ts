import { Deferred, Effect, Ref } from "effect";
import { type Interaction, type Message } from "discord.js";

import { parseQuestionActionId, questionInteractionReply } from "@/discord/question-card.ts";
import {
  createQuestionWorkflow,
  type QuestionWorkflow,
  type QuestionWorkflowEvent,
  type QuestionWorkflowSignal,
} from "@/sessions/question-coordinator.ts";
import type { SessionContext } from "@/sessions/session-runtime.ts";
import type { OpencodeServiceShape } from "@/opencode/service.ts";
import type { LoggerShape } from "@/util/logging.ts";

type WorkflowGate<A> = Deferred.Deferred<A, unknown>;
type QuestionRuntimeState = {
  workflows: Map<string, QuestionWorkflow>;
  requestRoutes: Map<string, string>;
  gates: Map<string, WorkflowGate<QuestionWorkflow>>;
};
type QuestionWorkflowGate = WorkflowGate<QuestionWorkflow>;
type QuestionWorkflowGateDecision =
  | { type: "existing"; workflow: QuestionWorkflow }
  | { type: "await"; gate: QuestionWorkflowGate }
  | { type: "create"; gate: QuestionWorkflowGate };

export type RoutedQuestionSignals = {
  sessionId: string;
  signals: ReadonlyArray<QuestionWorkflowSignal>;
};

const SHUTDOWN_QUESTION_RPC_TIMEOUT = "1 second";

export type QuestionRuntime = {
  handleEvent: (
    event: { sessionId: string } & QuestionWorkflowEvent,
  ) => Effect.Effect<RoutedQuestionSignals | null, unknown>;
  routeInteraction: (
    interaction: Interaction,
  ) => Effect.Effect<RoutedQuestionSignals | null, unknown>;
  hasPendingQuestions: (sessionId: string) => Effect.Effect<boolean, unknown>;
  hasPendingQuestionsAnywhere: () => Effect.Effect<boolean, unknown>;
  terminateSession: (
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<QuestionWorkflowSignal>, unknown>;
  shutdownSession: (sessionId: string) => Effect.Effect<void, unknown>;
  cleanupShutdownQuestions: () => Effect.Effect<void, unknown>;
};

type QuestionRuntimeDeps = {
  getSessionContext: (sessionId: string) => Effect.Effect<SessionContext | null>;
  replyToQuestion: OpencodeServiceShape["replyToQuestion"];
  rejectQuestion: OpencodeServiceShape["rejectQuestion"];
  sendQuestionUiFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>;
  logger: LoggerShape;
  formatError: (error: unknown) => string;
};

const createQuestionRuntimeState = (): QuestionRuntimeState => ({
  workflows: new Map(),
  requestRoutes: new Map(),
  gates: new Map(),
});

const QuestionRuntimeState = {
  getWorkflow: (state: QuestionRuntimeState, sessionId: string) =>
    state.workflows.get(sessionId) ?? null,
  lookupRequest: (state: QuestionRuntimeState, requestId: string) => {
    const sessionId = state.requestRoutes.get(requestId) ?? null;
    if (!sessionId) {
      return null;
    }

    return {
      sessionId,
      workflow: state.workflows.get(sessionId) ?? null,
    } as const;
  },
  trackRequest: (state: QuestionRuntimeState, sessionId: string, requestId: string) => {
    const requestRoutes = new Map(state.requestRoutes);
    requestRoutes.set(requestId, sessionId);
    return {
      ...state,
      requestRoutes,
    };
  },
  releaseRequest: (state: QuestionRuntimeState, requestId: string) => {
    if (!state.requestRoutes.has(requestId)) {
      return state;
    }

    const requestRoutes = new Map(state.requestRoutes);
    requestRoutes.delete(requestId);
    return {
      ...state,
      requestRoutes,
    };
  },
  beginWorkflowCreate: (
    state: QuestionRuntimeState,
    sessionId: string,
    gate: QuestionWorkflowGate,
  ): readonly [QuestionWorkflowGateDecision, QuestionRuntimeState] => {
    const existing = state.workflows.get(sessionId);
    if (existing) {
      return [{ type: "existing", workflow: existing }, state];
    }

    const currentGate = state.gates.get(sessionId);
    if (currentGate) {
      return [{ type: "await", gate: currentGate }, state];
    }

    const gates = new Map(state.gates);
    gates.set(sessionId, gate);
    return [
      { type: "create", gate },
      {
        ...state,
        gates,
      },
    ];
  },
  storeWorkflow: (
    state: QuestionRuntimeState,
    sessionId: string,
    gate: QuestionWorkflowGate,
    workflow: QuestionWorkflow,
  ) => {
    if (state.gates.get(sessionId) !== gate) {
      return state;
    }

    const workflows = new Map(state.workflows);
    workflows.set(sessionId, workflow);
    const gates = new Map(state.gates);
    gates.delete(sessionId);
    return {
      ...state,
      workflows,
      gates,
    };
  },
  clearWorkflowCreate: (
    state: QuestionRuntimeState,
    sessionId: string,
    gate: QuestionWorkflowGate,
  ) => {
    if (state.gates.get(sessionId) !== gate) {
      return state;
    }

    const gates = new Map(state.gates);
    gates.delete(sessionId);
    return {
      ...state,
      gates,
    };
  },
  deleteWorkflow: (state: QuestionRuntimeState, sessionId: string, workflow?: QuestionWorkflow) => {
    const existing = state.workflows.get(sessionId);
    if (!existing || (workflow && existing !== workflow)) {
      return state;
    }

    const workflows = new Map(state.workflows);
    workflows.delete(sessionId);
    return {
      ...state,
      workflows,
    };
  },
} as const;

export const makeQuestionRuntime = (deps: QuestionRuntimeDeps): Effect.Effect<QuestionRuntime> =>
  Effect.gen(function* () {
    const runtimeStateRef = yield* Ref.make(createQuestionRuntimeState());
    const stoppedSessionEventIdsRef = yield* Ref.make(new Set<string>());
    const readState = () => Ref.get(runtimeStateRef);
    const updateState = (f: (state: QuestionRuntimeState) => QuestionRuntimeState) =>
      Ref.update(runtimeStateRef, f);
    const readStoppedSessionEventIds = () => Ref.get(stoppedSessionEventIdsRef);
    const stopHandlingSessionEvents = (sessionId: string) =>
      Ref.update(stoppedSessionEventIdsRef, (current) => {
        if (current.has(sessionId)) {
          return current;
        }

        const next = new Set(current);
        next.add(sessionId);
        return next;
      });
    const getQuestionWorkflow = (sessionId: string) =>
      readState().pipe(Effect.map((state) => QuestionRuntimeState.getWorkflow(state, sessionId)));
    const getQuestionWorkflowGate = (sessionId: string) =>
      readState().pipe(Effect.map((state) => state.gates.get(sessionId) ?? null));
    const getQuestionWorkflowByRequestId = (requestId: string) =>
      readState().pipe(Effect.map((state) => QuestionRuntimeState.lookupRequest(state, requestId)));

    const getOrCreateQuestionWorkflow = (sessionId: string) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<QuestionWorkflow, unknown>();
        const decision = yield* Ref.modify(
          runtimeStateRef,
          (current): readonly [QuestionWorkflowGateDecision, QuestionRuntimeState] =>
            QuestionRuntimeState.beginWorkflowCreate(current, sessionId, gate),
        );

        switch (decision.type) {
          case "existing":
            return decision.workflow;
          case "await":
            return yield* Deferred.await(decision.gate);
          case "create":
            break;
        }

        let workflow: QuestionWorkflow | null = null;
        const exit = yield* createQuestionWorkflow({
          getSessionContext: () => deps.getSessionContext(sessionId),
          replyToQuestion: deps.replyToQuestion,
          rejectQuestion: deps.rejectQuestion,
          sendQuestionUiFailure: deps.sendQuestionUiFailure,
          trackRequestId: (requestId: string) =>
            updateState((state) => QuestionRuntimeState.trackRequest(state, sessionId, requestId)),
          releaseRequestId: (requestId: string) =>
            updateState((state) => QuestionRuntimeState.releaseRequest(state, requestId)),
          onDrained: () =>
            workflow
              ? updateState((state) =>
                  QuestionRuntimeState.deleteWorkflow(state, sessionId, workflow ?? undefined),
                )
              : Effect.void,
          logger: deps.logger,
          formatError: deps.formatError,
        }).pipe(
          Effect.tap((created) =>
            Effect.sync(() => {
              workflow = created;
            }).pipe(
              Effect.andThen(
                updateState((state) =>
                  QuestionRuntimeState.storeWorkflow(state, sessionId, decision.gate, created),
                ),
              ),
            ),
          ),
          Effect.exit,
        );

        yield* Deferred.done(decision.gate, exit).pipe(Effect.ignore);
        if (exit._tag === "Failure") {
          yield* updateState((state) =>
            QuestionRuntimeState.clearWorkflowCreate(state, sessionId, decision.gate),
          );
          return yield* Effect.failCause(exit.cause);
        }
        return exit.value;
      });

    const hasPendingQuestions = (sessionId: string) =>
      getQuestionWorkflow(sessionId).pipe(
        Effect.flatMap((workflow) =>
          workflow ? workflow.hasPendingQuestions() : Effect.succeed(false),
        ),
      );

    const hasPendingQuestionsAnywhere = () =>
      readState().pipe(
        Effect.flatMap((state) =>
          Effect.forEach(state.workflows.values(), (workflow) => workflow.hasPendingQuestions(), {
            concurrency: "unbounded",
            discard: false,
          }),
        ),
        Effect.map((pending) => pending.some(Boolean)),
      );

    const getShutdownTargetWorkflow = (sessionId: string) =>
      getQuestionWorkflow(sessionId).pipe(
        Effect.flatMap((workflow) =>
          workflow
            ? Effect.succeed(workflow)
            : getQuestionWorkflowGate(sessionId).pipe(
                Effect.flatMap((gate) =>
                  !gate
                    ? Effect.succeed(null)
                    : Deferred.await(gate).pipe(Effect.catch(() => Effect.succeed(null))),
                ),
              ),
        ),
      );

    const rejectQuestionIdsForShutdown = (sessionId: string, requestIds: ReadonlyArray<string>) =>
      deps.getSessionContext(sessionId).pipe(
        Effect.flatMap((context) =>
          !context || requestIds.length === 0
            ? Effect.void
            : Effect.forEach(
                requestIds,
                (requestId) =>
                  deps.rejectQuestion(context.session.opencode, requestId).pipe(
                    Effect.timeoutOption(SHUTDOWN_QUESTION_RPC_TIMEOUT),
                    Effect.flatMap((result) =>
                      result._tag === "Some"
                        ? Effect.void
                        : Effect.fail(new Error(`Timed out rejecting question ${requestId}`)),
                    ),
                    Effect.result,
                  ),
                { concurrency: "unbounded", discard: false },
              ).pipe(
                Effect.flatMap((results) => {
                  const failure = results.find((result) => result._tag === "Failure");
                  if (!failure) {
                    return Effect.void;
                  }

                  return deps.logger
                    .warn("question rejection was unresponsive during shutdown", {
                      sessionId,
                      error: deps.formatError(failure.failure),
                    })
                    .pipe(
                      Effect.andThen(
                        context.session.opencode.close().pipe(
                          Effect.catch((error) =>
                            deps.logger.warn(
                              "failed to force-close opencode session during question shutdown",
                              {
                                sessionId,
                                error: deps.formatError(error),
                              },
                            ),
                          ),
                        ),
                      ),
                    );
                }),
              ),
        ),
      );

    const handleEvent = (event: { sessionId: string } & QuestionWorkflowEvent) =>
      Effect.gen(function* () {
        if ((yield* readStoppedSessionEventIds()).has(event.sessionId)) {
          return null;
        }

        const workflow =
          event.type === "asked"
            ? yield* getOrCreateQuestionWorkflow(event.sessionId)
            : yield* getQuestionWorkflow(event.sessionId);
        if (!workflow) {
          return null;
        }

        const signals = yield* workflow.handleEvent(
          event.type === "asked"
            ? { type: "asked", request: event.request }
            : event.type === "replied"
              ? {
                  type: "replied",
                  requestId: event.requestId,
                  answers: event.answers,
                }
              : { type: "rejected", requestId: event.requestId },
        );
        return {
          sessionId: event.sessionId,
          signals,
        } satisfies RoutedQuestionSignals;
      });

    const routeInteraction = (interaction: Interaction) =>
      Effect.gen(function* () {
        if (
          !interaction.isButton() &&
          !interaction.isStringSelectMenu() &&
          !interaction.isModalSubmit()
        ) {
          return null;
        }

        const action = parseQuestionActionId(interaction.customId);
        if (!action) {
          return null;
        }

        const routed = yield* getQuestionWorkflowByRequestId(action.requestID);
        if (!routed || !routed.workflow) {
          if (routed && !routed.workflow) {
            yield* updateState((state) =>
              QuestionRuntimeState.releaseRequest(state, action.requestID),
            );
          }
          if (!interaction.replied && !interaction.deferred) {
            yield* Effect.promise(() =>
              interaction.reply(questionInteractionReply("This question prompt has expired.")),
            ).pipe(Effect.ignore);
          }
          return null;
        }

        const signals = yield* routed.workflow.handleInteraction(interaction);
        return {
          sessionId: routed.sessionId,
          signals,
        } satisfies RoutedQuestionSignals;
      });

    const terminateSession = (sessionId: string) =>
      getQuestionWorkflow(sessionId).pipe(
        Effect.flatMap((workflow) => (!workflow ? Effect.succeed([]) : workflow.terminate())),
      );

    const cleanupShutdownSession = (sessionId: string) =>
      stopHandlingSessionEvents(sessionId).pipe(
        Effect.andThen(getShutdownTargetWorkflow(sessionId)),
        Effect.flatMap((workflow) =>
          !workflow
            ? Effect.void
            : workflow
                .shutdown()
                .pipe(
                  Effect.flatMap((requestIds) =>
                    rejectQuestionIdsForShutdown(sessionId, requestIds),
                  ),
                ),
        ),
      );

    const shutdownSession = (sessionId: string) => cleanupShutdownSession(sessionId);

    const cleanupShutdownQuestions = () =>
      readState().pipe(
        Effect.flatMap((state) =>
          Effect.forEach(
            new Set([...state.workflows.keys(), ...state.gates.keys()]),
            cleanupShutdownSession,
            {
              concurrency: "unbounded",
              discard: true,
            },
          ),
        ),
        Effect.asVoid,
      );

    return {
      handleEvent,
      routeInteraction,
      hasPendingQuestions,
      hasPendingQuestionsAnywhere,
      terminateSession,
      shutdownSession,
      cleanupShutdownQuestions,
    } satisfies QuestionRuntime;
  });
