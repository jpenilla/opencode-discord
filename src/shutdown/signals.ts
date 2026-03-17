export type ShutdownSignal = "SIGINT" | "SIGTERM";

export type ShutdownSignalTarget = {
  on: (event: ShutdownSignal, listener: () => void) => void;
  off: (event: ShutdownSignal, listener: () => void) => void;
};

export const installShutdownSignalHandlers = (input: {
  target: ShutdownSignalTarget;
  onFirstSignal: (signal: ShutdownSignal) => void;
  onSecondSignal: (signal: ShutdownSignal) => void;
}) => {
  let signaled = false;

  const handleSignal =
    (signal: ShutdownSignal) =>
    () => {
      if (!signaled) {
        signaled = true;
        input.onFirstSignal(signal);
        return;
      }

      input.onSecondSignal(signal);
    };

  const onSigint = handleSignal("SIGINT");
  const onSigterm = handleSignal("SIGTERM");

  input.target.on("SIGINT", onSigint);
  input.target.on("SIGTERM", onSigterm);

  return () => {
    input.target.off("SIGINT", onSigint);
    input.target.off("SIGTERM", onSigterm);
  };
};
