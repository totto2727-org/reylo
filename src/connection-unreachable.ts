import { matchesNullish, matchesUndefined } from "./native-predicates.ts";

const UNREACHABLE = Symbol.for("reylo.unreachable");

interface DriverFailure {
  code?: string;
  errors?: { message?: string }[];
  message?: string;
}

const presentText = (value: string | undefined): string | undefined => {
  const present = Boolean(value);
  return present ? value : undefined;
};

export const connectionField = (value: unknown, key: PropertyKey): unknown => {
  if (matchesNullish(value)) {return undefined;}
  const receiver: object = new Object(value);
  return Reflect.get(receiver, key, value);
};

/**
 * Format a driver error and its nested connection failures on one line.
 * @param {unknown} failure - The error reported by the native driver.
 * @returns {string} The driver message, aggregated failures, code, or native string conversion.
 */
export const reason = function reason(failure: unknown): string {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Preserve driver diagnostics including extended errors and their original property access.
  const driver = failure as DriverFailure | undefined;
  const message = presentText(driver?.message);
  if (!matchesUndefined(message)) {return message;}
  const nested = presentText(driver?.errors?.map((error) => error.message).filter(Boolean).join("; "));
  if (!matchesUndefined(nested)) {return nested;}
  return presentText(driver?.code) ?? String(failure);
};

/**
 * The database cannot be reached. Repeated attempts by drivers with connection backoff would hold
 * the transform. The global symbol also identifies errors from another copy of the runtime.
 */
// oxlint-disable-next-line rules/require-tagged-error, unicorn/custom-error-definition -- Preserve the public class and its native Error behavior across tool and runtime bundles.
export class Unreachable extends Error {
  // oxlint-disable-next-line rules/no-readonly -- Preserve the existing error's immutable public brand.
  public readonly [UNREACHABLE] = true;
  // oxlint-disable-next-line unicorn/custom-error-definition -- Existing callers see the inherited native name "Error".
  public constructor(cause: unknown) {
    super(reason(cause), { cause });
  }
  public static [Symbol.hasInstance](value: unknown): boolean {
    return connectionField(value, UNREACHABLE) === true;
  }
}
