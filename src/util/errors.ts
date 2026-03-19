type ErrorLike = {
  readonly message: string;
};

const isErrorLike = (value: unknown): value is ErrorLike =>
  typeof value === "object" &&
  value !== null &&
  "message" in value &&
  typeof value.message === "string";

export const formatError = (error: unknown) => (isErrorLike(error) ? error.message : String(error));
