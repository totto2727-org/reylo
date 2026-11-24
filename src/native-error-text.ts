export const nativeErrorText = (failure: unknown, format: "message" | "stack"): string => {
  // oxlint-disable-next-line rules/no-instanceof-error -- The native runtime must recognize Error without loading Effect.
  if (failure instanceof Error) {
    return format === "stack" ? failure.stack ?? failure.message : failure.message;
  }
  return String(failure);
};
