import { Deferred, Effect, Ref } from "effect";
import { type Interaction, type Message } from "discord.js";

import { parseQuestionActionId, questionInteractionReply } from "@/discord/question-card.ts";
import {
  createQuestionWorkflow,
  type QuestionWorkflow,
  type QuestionWorkflowEvent,
  type QuestionWorkflowSignal,
} from "@/sessions/question-coordinator.ts";
import type { SessionContext } from "@/sessions/session-lifecycle.ts";
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

export type QuestionShutdownState = {
  sessionId: string;
  requestIds: ReadonlyArray<string>;
  signals: ReadonlyArray<QuestionWorkflowSignal>;
};

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
  beginShutdown: () => Effect.Effect<void, unknown>;
  shutdownSession: (sessionId: string) => Effect.Effect<QuestionShutdownState | null, unknown>;
  finalizeShutdownUi: () => Effect.Effect<ReadonlyArray<RoutedQuestionSignals>, unknown>;
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
    const readState = () => Ref.get(runtimeStateRef);
    const updateState = (f: (state: QuestionRuntimeState) => QuestionRuntimeState) =>
      Ref.update(runtimeStateRef, f);
    const getQuestionWorkflow = (sessionId: string) =>
      readState().pipe(Effect.map((state) => QuestionRuntimeState.getWorkflow(state, sessionId)));
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

    const handleEvent = (event: { sessionId: string } & QuestionWorkflowEvent) =>
      Effect.gen(function* () {
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

    const beginShutdown = () =>
      readState().pipe(
        Effect.flatMap((state) =>
          Effect.forEach(state.workflows.values(), (workflow) => workflow.beginShutdown(), {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      );

    const shutdownSession = (sessionId: string) =>
      getQuestionWorkflow(sessionId).pipe(
        Effect.flatMap((workflow) =>
          !workflow
            ? Effect.succeed(null)
            : workflow.shutdown().pipe(
                Effect.map((state) => ({
                  sessionId,
                  requestIds: state.requestIds,
                  signals: state.signals,
                })),
              ),
        ),
      );

    const finalizeShutdownUi = () =>
      readState().pipe(
        Effect.flatMap((state) =>
          Effect.forEach(
            state.workflows.entries(),
            ([sessionId, workflow]) =>
              workflow.shutdown().pipe(
                Effect.map((shutdownState) => ({
                  sessionId,
                  signals: shutdownState.signals,
                })),
              ),
            {
              concurrency: "unbounded",
              discard: false,
            },
          ),
        ),
      );

    return {
      handleEvent,
      routeInteraction,
      hasPendingQuestions,
      hasPendingQuestionsAnywhere,
      terminateSession,
      beginShutdown,
      shutdownSession,
      finalizeShutdownUi,
    } satisfies QuestionRuntime;
  });
