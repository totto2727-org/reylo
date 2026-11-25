import { matchesNull } from "./native-predicates.ts";

// oxlint-disable-next-line rules/require-tagged-error, unicorn/custom-error-definition -- Keep the native TypeError name and ParameterError constructor identity used by synchronous callers.
export class ParameterError extends TypeError {}

const DISPLAY_TEXT_LIMIT = 60;
const TEXT_START = 0;
const ELLIPSIS = "...";

const describeText = (value: string): string =>
  JSON.stringify(value.length > DISPLAY_TEXT_LIMIT ? `${value.slice(TEXT_START, DISPLAY_TEXT_LIMIT - ELLIPSIS.length)}${ELLIPSIS}` : value);

const describeObject = (value: object | null): string => {
  if (matchesNull(value)) {return "null";}
  if (value instanceof Date) {return "a Date";}
  if (Array.isArray(value)) {return "an array";}
  if (value instanceof Uint8Array) {return "binary data";}
  return "an object";
};

/**
 * Describes a supplied value for a parameter diagnostic.
 * @param {unknown} value The supplied value.
 * @returns {string} Its kind or short literal form.
 */
export const describe = function describe(value: unknown): string {
  switch (typeof value) {
    case "object": {return describeObject(value);}
    case "bigint": {return `${value}n`;}
    case "string": {return describeText(value);}
    case "boolean":
    case "function":
    case "number":
    case "symbol":
    case "undefined": {return String(value);}
    default: {return String(value);}
  }
};
