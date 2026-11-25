/** An engine that is absent, unresponsive, or serves another upstream release. */
// oxlint-disable-next-line rules/require-tagged-error, unicorn/custom-error-definition -- Preserve the exported native Error class and its documented name.
export class MissingEngine extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MissingEngine";
  }
}

export const missingEngine = (error: unknown): MissingEngine =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Preserve the native loader diagnostic collected from the project's executable.
  new MissingEngine((error as Error).message);
