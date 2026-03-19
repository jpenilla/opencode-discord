import type { Message } from "discord.js";
import { Effect, Ref } from "effect";

import type { SessionHandle } from "@/opencode/service.ts";
import type { LoggerShape } from "@/util/logging.ts";
import { unsafeStub } from "./stub.ts";

export const getRef = <A>(ref: Ref.Ref<A>) => Effect.runPromise(Ref.get(ref));

export const makeSilentLogger = (): LoggerShape => ({
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
});

export const makeMessage = (
  input:
    | string
    | ({
        id: string;
        attachmentCount?: number;
        attachments?: Message["attachments"];
      } & Record<string, unknown>),
): Message => {
  const {
    attachmentCount = 0,
    attachments,
    ...message
  } = typeof input === "string" ? { id: input } : input;
  return unsafeStub<Message>({
    attachments:
      attachments ??
      new Map(
        Array.from({ length: attachmentCount }, (_, index) => [
          `att-${message.id}-${index}`,
          { id: `att-${message.id}-${index}` },
        ]),
      ),
    ...message,
  });
};

export const makeSessionHandle = (handle: Partial<SessionHandle> = {}): SessionHandle =>
  unsafeStub<SessionHandle>({
    sessionId: "session-1",
    client: {} as SessionHandle["client"],
    workdir: "/home/opencode/workspace",
    backend: "bwrap",
    close: () => Effect.void,
    ...handle,
  });
