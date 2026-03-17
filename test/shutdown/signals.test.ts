import { describe, expect, test } from "bun:test";

import {
  installShutdownSignalHandlers,
  type ShutdownSignal,
  type ShutdownSignalTarget,
} from "@/shutdown/signals.ts";

const makeTarget = () => {
  const listeners = new Map<ShutdownSignal, Set<() => void>>([
    ["SIGINT", new Set()],
    ["SIGTERM", new Set()],
  ]);

  const target: ShutdownSignalTarget = {
    on: (event, listener) => {
      listeners.get(event)?.add(listener);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
  };

  const emit = (signal: ShutdownSignal) => {
    for (const listener of listeners.get(signal) ?? []) {
      listener();
    }
  };

  return {
    target,
    emit,
    listenerCount: (signal: ShutdownSignal) => listeners.get(signal)?.size ?? 0,
  };
};

describe("installShutdownSignalHandlers", () => {
  test("routes the first signal to graceful shutdown and the second to forced exit", () => {
    const received: string[] = [];
    const target = makeTarget();
    const cleanup = installShutdownSignalHandlers({
      target: target.target,
      onFirstSignal: (signal) => {
        received.push(`first:${signal}`);
      },
      onSecondSignal: (signal) => {
        received.push(`second:${signal}`);
      },
    });

    target.emit("SIGINT");
    target.emit("SIGINT");

    expect(received).toEqual(["first:SIGINT", "second:SIGINT"]);

    cleanup();
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });

  test("treats any later termination signal as the forced-exit path", () => {
    const received: string[] = [];
    const target = makeTarget();
    installShutdownSignalHandlers({
      target: target.target,
      onFirstSignal: (signal) => {
        received.push(`first:${signal}`);
      },
      onSecondSignal: (signal) => {
        received.push(`second:${signal}`);
      },
    });

    target.emit("SIGTERM");
    target.emit("SIGINT");

    expect(received).toEqual(["first:SIGTERM", "second:SIGINT"]);
  });
});
