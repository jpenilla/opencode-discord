import type {
  Event,
  GlobalEvent,
  QuestionAnswer,
  QuestionRequest,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2";

import { unsafeStub } from "./stub.ts";

export const toGlobalEvent = (payload: Event): GlobalEvent => unsafeStub<GlobalEvent>({ payload });

export const makeQuestionAskedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "question.asked",
    properties: {
      id: "req-1",
      sessionID: sessionId,
      questions: [
        {
          header: "Question",
          question: "Question?",
          options: [{ label: "Yes", description: "desc" }],
        },
      ],
      tool: {
        messageID: "message-1",
        callID: "call-1",
      },
    } satisfies QuestionRequest,
  });

export const makeQuestionRepliedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "question.replied",
    properties: {
      sessionID: sessionId,
      requestID: "req-1",
      answers: [["Yes"]] satisfies ReadonlyArray<QuestionAnswer>,
    },
  });

export const makeQuestionRejectedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "question.rejected",
    properties: {
      sessionID: sessionId,
      requestID: "req-1",
    },
  });

export const makeSessionStatusEvent = (
  sessionId = "session-1",
  status: "busy" | "idle" = "busy",
): Event =>
  unsafeStub<Event>({
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: { type: status },
    },
  });

export const makeSessionCompactedEvent = (sessionId = "session-1"): Event =>
  unsafeStub<Event>({
    type: "session.compacted",
    properties: {
      sessionID: sessionId,
    },
  });

export const makeAssistantMessageUpdatedEvent = (input: {
  id: string;
  sessionId?: string;
  parentId: string;
  summary?: boolean;
  mode?: string;
  completed?: boolean;
  error?: { name: "MessageAbortedError"; data: { message: string } };
}): Event =>
  unsafeStub<Event>({
    type: "message.updated",
    properties: {
      info: {
        id: input.id,
        sessionID: input.sessionId ?? "session-1",
        role: "assistant",
        parentID: input.parentId,
        mode: input.mode ?? "chat",
        summary: input.summary,
        error: input.error,
        providerID: "provider-1",
        modelID: "model-1",
        agent: input.summary ? "compaction" : "main",
        path: {
          cwd: "/home/opencode/workspace",
          root: "/home/opencode/workspace",
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        time:
          input.completed === false
            ? { created: 1 }
            : {
                created: 1,
                completed: 2,
              },
      },
    },
  });

export const makeUserMessageUpdatedEvent = (
  input: string | { id: string; sessionId?: string } = "user-1",
): Event => {
  const data = typeof input === "string" ? { id: input } : input;
  return unsafeStub<Event>({
    type: "message.updated",
    properties: {
      info: {
        id: data.id,
        sessionID: data.sessionId ?? "session-1",
        role: "user",
        agent: "main",
        model: {
          providerID: "provider-1",
          modelID: "model-1",
        },
        time: {
          created: 1,
        },
      } satisfies UserMessage,
    },
  });
};

export const makeToolPart = (
  status: "running" | "completed" | "error",
  input?: {
    sessionId?: string;
    messageId?: string;
    callId?: string;
  },
): ToolPart =>
  unsafeStub<ToolPart>({
    id: `part-${status}`,
    sessionID: input?.sessionId ?? "session-1",
    messageID: input?.messageId ?? "assistant-1",
    type: "tool",
    callID: input?.callId ?? "call-1",
    tool: "bash",
    state:
      status === "running"
        ? {
            status: "running",
            input: {
              command: "pwd",
            },
            title: "Print cwd",
            time: {
              start: 1,
            },
          }
        : status === "completed"
          ? {
              status: "completed",
              input: {
                command: "pwd",
              },
              title: "Print cwd",
              time: {
                start: 1,
                end: 2,
              },
            }
          : {
              status: "error",
              input: {
                command: "pwd",
              },
              error: "aborted",
              time: {
                start: 1,
                end: 2,
              },
            },
  });

export const makeToolEvent = (
  status: "running" | "completed" | "error",
  input?: {
    sessionId?: string;
    messageId?: string;
    callId?: string;
  },
): Event =>
  unsafeStub<Event>({
    type: "message.part.updated",
    properties: {
      part: makeToolPart(status, input),
    },
  });
