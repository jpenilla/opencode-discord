import { Context, Effect, Layer } from "effect";

export type LoggerShape = {
  info: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void>;
  warn: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void>;
  error: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void>;
};

export class Logger extends Context.Tag("Logger")<Logger, LoggerShape>() {}

const write = (level: string, message: string, fields?: Record<string, unknown>) =>
  Effect.sync(() => {
    const payload = {
      time: new Date().toISOString(),
      level,
      message,
      ...fields,
    };
    console.log(JSON.stringify(payload));
  });

export const LoggerLive = Layer.succeed(Logger, {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
} satisfies LoggerShape);
