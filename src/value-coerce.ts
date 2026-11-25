import { isEmptyString, matchesBigInt, matchesBoolean, matchesNull, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import { bytea } from "./value-bytes.ts";
import { bigInteger, exactInteger, float32s, truth } from "./value-numbers.ts";
import { duration, hstore, jsonValue, parseArray, SQL_NULL_VALUE } from "./value-text.ts";
import { instant, instantOfDate, utcText } from "./value-time.ts";
import type { Kind } from "./values.ts";

const ARRAY_KIND_SUFFIX = "[]";
const TEXT_START = 0;
const DEFAULT_DELIMITER = ",";

const coerceNumber = (kind: "int" | "float", value: unknown, column: string): unknown => {
  if (matchesNumber(value)) {return kind === "int" ? exactInteger(value, column) : value;}
  if (matchesBigInt(value)) {return exactInteger(value, column);}
  if (!matchesString(value) || isEmptyString(value)) {return value;}
  const number = Number(value);
  if (Number.isNaN(number)) {return value;}
  return kind === "int" && /^[+-]?\d+$/u.test(value) ? exactInteger(BigInt(value), column) : number;
};

const dateInfinity = (value: unknown): unknown => {
  // Bun.sql returns the two temporal infinities as numbers.
  if (value === Infinity) {return "infinity";}
  if (value === -Infinity) {return "-infinity";}
  return value;
};

const coerceCalendar = (kind: "date" | "timestamp", value: unknown, column: string): unknown =>
  value instanceof Date ? utcText(value, kind, column) : dateInfinity(value);

const coerceInstant = (value: unknown, column: string): unknown => {
  if (matchesString(value)) {return instant(value);}
  return value instanceof Date ? instantOfDate(value, column) : dateInfinity(value);
};

const coerceBytes = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {return value;}
  if (value instanceof ArrayBuffer) {return new Uint8Array(value);}
  // D1's BLOB is an array of numbers. Let the native constructor apply its normal coercion.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- D1 supplies a number array, and Uint8Array.from retains its native conversion for any other array.
  if (Array.isArray(value)) {return Uint8Array.from(value as number[]);}
  // MariaDB and Bun.sql return BIT(1) as a truth value.
  if (matchesBoolean(value)) {return Uint8Array.of(Number(value));}
  return matchesString(value) ? bytea(value) : value;
};

const coerceText = (value: unknown): unknown => {
  // MariaDB's SET is an array of its members.
  if (Array.isArray(value)) {return value.join(",");}
  if (matchesNumber(value) || matchesBigInt(value)) {return String(value);}
  return value;
};

type ScalarCoercion = (value: unknown, column: string) => unknown;

const SCALAR_COERCIONS = new Map<string, ScalarCoercion>([
  ["bool", truth],
  ["int", (value, column) => coerceNumber("int", value, column)],
  ["float", (value, column) => coerceNumber("float", value, column)],
  ["int8", (value, column) => matchesBigInt(value) || matchesNumber(value) || matchesString(value) ? bigInteger(value, column) : value],
  ["decimal", (value) => matchesBigInt(value) || matchesNumber(value) ? String(value) : value],
  ["date", (value, column) => coerceCalendar("date", value, column)],
  ["timestamp", (value, column) => coerceCalendar("timestamp", value, column)],
  ["timestamptz", coerceInstant],
  ["interval", (value) => matchesString(value) ? duration(value) : value],
  ["json", (value) => matchesString(value) ? jsonValue(value) : value],
  ["vector", (value) => matchesString(value) ? jsonValue(value) : value],
  ["hstore", (value) => matchesString(value) ? hstore(value) : value],
  ["bytes", coerceBytes],
  ["text", coerceText],
]);

const chooseNumber = (kinds: Readonly<string[]>, value: number, column: string): unknown => {
  // Where the column may hold a float, a number past 2^53 may be one.
  if (kinds.includes("float") || !Number.isInteger(value)) {return value;}
  if (kinds.includes("int")) {return exactInteger(value, column);}
  return kinds.includes("int8") ? bigInteger(value, column) : value;
};

const chooseDate = (kinds: Readonly<string[]>, value: Date, column: string): unknown => {
  if (kinds.includes("timestamp")) {return utcText(value, "timestamp", column);}
  if (kinds.includes("date")) {return utcText(value, "date", column);}
  return kinds.includes("timestamptz") ? instantOfDate(value, column) : value;
};

// A string in a union is a DECIMAL or text. The MySQL drivers already read BIGINT as a BigInt.
const coerceEither = (kind: Kind, value: unknown, column: string): unknown => {
  const kinds = kind.split("|");
  if (matchesBigInt(value)) {return kinds.includes("int8") ? value : exactInteger(value, column);}
  if (matchesNumber(value)) {return chooseNumber(kinds, value, column);}
  if (value instanceof Date) {return chooseDate(kinds, value, column);}
  if (value instanceof ArrayBuffer || (Array.isArray(value) && kinds.includes("bytes"))) {return coerceBytes(value);}
  return value;
};

interface Settings {
  column: string;
  delimiter: string;
}

interface ArrayCoercion {
  element: Kind;
  settings: Settings;
  read: (value: unknown) => unknown;
  nested: (value: unknown) => unknown;
}

const coerceArray = (value: unknown, format: ArrayCoercion): unknown => {
  if (matchesString(value)) {return parseArray(value, format.read, format.settings.delimiter);}
  if (Array.isArray(value)) {return value.map((entry: unknown) => Array.isArray(entry) ? format.nested(entry) : format.read(entry));}
  // A MySQL VECTOR is the one array of floats that a driver hands us as bytes.
  if (format.element === "float" && value instanceof Uint8Array) {return float32s(value, format.settings.column);}
  // Bun.sql supplies typed arrays for int4[] and float4[].
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Typed arrays implement ArrayLike even when the standard ArrayBufferView type omits it.
    return Array.from(value as unknown as ArrayLike<unknown>, format.read);
  }
  return value;
};

const coerceValue = (kind: Kind, value: unknown, settings: Settings): unknown => {
  if (matchesNull(value) || matchesUndefined(value)) {return SQL_NULL_VALUE;}
  if (kind.endsWith(ARRAY_KIND_SUFFIX)) {
    const element = kind.slice(TEXT_START, -ARRAY_KIND_SUFFIX.length);
    const elementSettings = { column: settings.column, delimiter: DEFAULT_DELIMITER };
    return coerceArray(value, {
      element,
      nested: (entry) => coerceValue(kind, entry, settings),
      read: (entry) => coerceValue(element, entry, elementSettings),
      settings,
    });
  }
  if (kind.includes("|")) {return coerceEither(kind, value, settings.column);}
  const scalar = SCALAR_COERCIONS.get(kind);
  return matchesUndefined(scalar) ? value : scalar(value, settings.column);
};

/**
 * Converts the value a database driver returned to Reylo's representation. An integer the
 * driver rounded before giving it to us is refused.
 * @param {Kind} kind - The generated statement's representation kind.
 * @param {unknown} value - The value from the driver.
 * @param {string} column - The column name for decoding errors.
 * @param {string} delimiter - The delimiter used in text arrays.
 * @returns {unknown} The normalized driver value.
 */
// oxlint-disable-next-line eslint/max-params -- Generated modules call this positional API with a fourth argument for the array delimiter.
export const coerce = function coerce(kind: Kind, value: unknown, column: string, delimiter = DEFAULT_DELIMITER): unknown {
  return coerceValue(kind, value, { column, delimiter });
};
