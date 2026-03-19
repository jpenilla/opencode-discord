import { Data, Effect } from "effect";

export class TestError extends Data.TaggedError("TestError")<{
  readonly message: string;
}> {}

export class TestInterruptedError extends Data.TaggedError("TestInterruptedError")<{
  readonly message: string;
}> {}

export class TestTimeoutError extends Data.TaggedError("TestTimeoutError")<{
  readonly message: string;
}> {}

export const failTest = (message: string) => Effect.fail(new TestError({ message }));

export const interruptedTestError = (message: string) => new TestInterruptedError({ message });

export const timeoutTestError = (message: string) => new TestTimeoutError({ message });
