import { hasObjectType, isEmptyArray, matchesBoolean, matchesNull, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import { decimal, integer, INTEGERS } from "./row-numeric.ts";
import type { RejectParameter } from "./row-numeric.ts";
import { describe, hstoreText, postgresInterval, postgresYear, zoned } from "./values.ts";

export type RowDialect = "postgres" | "mysql" | "sqlite" | "duckdb";

export interface RowValueContext {
  dialect: RowDialect;
  fail: RejectParameter;
  written: string;
}

export const SINGLE_TYPE_MODIFIER = /\(\s*(?<digits>\d+)\s*\)/u;
const HEX_RADIX = 16;
const NO_CHARACTERS = 0;
const ONE_CHARACTER = 1;
const WIDE_INTEGERS = new Set(["int8", "integer"]);

// Raw JSON text for an integer the writer emits as digits.
export class Raw {
  public text: string;
  public constructor(text: string) {
    this.text = text;
  }
}

const generic = (value: unknown, { fail, written }: RowValueContext): unknown => {
  // A type without its own check accepts values JSON can convey directly.
  if (matchesString(value) || matchesNumber(value) || matchesBoolean(value)) {return value;}
  return fail(`is ${written}; got ${describe(value)}.`);
};

const finite = (value: unknown, { fail, written }: RowValueContext): unknown => {
  if (matchesNumber(value) && Number.isFinite(value)) {return value;}
  return fail(`is ${written}, a finite number; got ${describe(value)}.`);
};

const boolean = (value: unknown, { fail, written }: RowValueContext): unknown => {
  if (matchesBoolean(value)) {return value;}
  return fail(`is ${written}, true or false; got ${describe(value)}.`);
};

const string = (value: unknown, { fail, written }: RowValueContext): unknown => {
  if (!matchesString(value)) {return fail(`is ${written}, a string; got ${describe(value)}.`);}
  const limit = SINGLE_TYPE_MODIFIER.exec(written)?.groups?.digits;
  if (!matchesUndefined(limit)) {
    // Postgres and MySQL count Unicode code points as characters.
    const length = Iterator.from(value).reduce((count) => count + ONE_CHARACTER, NO_CHARACTERS);
    if (length > Number(limit)) {fail(`is ${written}, at most ${limit} characters; got ${length}, which the database would refuse or cut.`);}
  }
  return value;
};

const vector = (value: unknown, { fail, written }: RowValueContext): unknown => {
  // The driver's array is bound in the text form accepted by pgvector.
  if (Array.isArray(value) && !isEmptyArray(value) && value.every((member) => matchesNumber(member) && Number.isFinite(member))) {
    return JSON.stringify(value);
  }
  if (matchesString(value)) {return value;}
  return fail(`is ${written}, an array of finite numbers with one at least; got ${describe(value)}.`);
};

const hstore = (value: unknown, { fail, written }: RowValueContext): unknown => {
  if (!matchesNull(value) && hasObjectType(value)) {
    return hstoreText(value, (message) => fail(message.replace(/^is an hstore/u, `is ${written}`)));
  }
  if (matchesString(value)) {return value;}
  return fail(`is ${written}, an object of its keys whose values are strings or null; got ${describe(value)}.`);
};

const UUID = /^\{?[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}\}?$/u;

const uuid = (value: unknown, { fail, written }: RowValueContext): unknown => {
  if (matchesString(value) && UUID.test(value)) {return value;}
  return fail(`is ${written}, a UUID in hexadecimal; got ${describe(value)}.`);
};

const instant = (value: unknown, { dialect, fail, written }: RowValueContext): unknown => {
  if (value instanceof Date) {
    return fail(`is ${written}, which takes the instant as a string that names its zone, not a Date: pass date.toISOString() ("2026-10-12T19:06:48.282Z").`);
  }
  if (matchesString(value) && zoned.test(value.trim())) {return dialect === "postgres" ? postgresYear(value) : value;}
  return fail(`is ${written}, an instant: a string that names its zone ("2026-10-12T19:06:48.282Z", "2026-10-12 19:06:48+09"); got ${describe(value)}, which the server would read in the session's time zone.`);
};

const wallDate = (value: unknown, { dialect, fail, written }: RowValueContext): unknown => {
  if (matchesString(value)) {return dialect === "postgres" ? postgresYear(value) : value;}
  return fail(`is ${written}, a wall-clock reading with no zone, which takes its text ("2026-10-12 19:06:48.282", "2026-10-12"), not a Date: drivers write a Date's time in different zones.${value instanceof Date ? "" : ` Got ${describe(value)}.`}`);
};

const binary = (value: unknown, { dialect, fail, written }: RowValueContext): unknown => {
  if (!(value instanceof Uint8Array)) {return fail(`is ${written}, binary data, a Uint8Array; got ${describe(value)}.`);}
  const limit = SINGLE_TYPE_MODIFIER.exec(written)?.groups?.digits;
  if (!matchesUndefined(limit) && value.length > Number(limit)) {
    fail(`is ${written}, at most ${limit} bytes; got ${value.length}, which the database would refuse or cut.`);
  }
  return Iterator.from(value).reduce(
    (hex, byte) => hex + (byte < HEX_RADIX ? "0" : "") + byte.toString(HEX_RADIX),
    dialect === "postgres" ? String.raw`\x` : "",
  );
};

const interval = (value: unknown, { fail, written }: RowValueContext): unknown => {
  // The driver prints negative intervals as -P1D. Postgres reads the translated form.
  if (matchesString(value)) {return postgresInterval(value);}
  if (matchesNumber(value)) {return value;}
  return fail(`is ${written}; got ${describe(value)}.`);
};

type Check = (value: unknown, context: RowValueContext) => unknown;

const CHECKS = new Map<string, Check>([
  ["blob", binary],
  ["bool", boolean],
  ["bpchar", string],
  ["bytea", binary],
  ["char", string],
  ["citext", string],
  ["date", wallDate],
  ["float4", finite],
  ["float8", finite],
  ["halfvec", vector],
  ["hstore", hstore],
  ["interval", interval],
  ["name", string],
  ["numeric", (value, { fail, written }) => decimal(written, value, fail)],
  ["real", finite],
  ["text", string],
  ["timestamp", wallDate],
  ["timestamptz", instant],
  ["uuid", uuid],
  ["varchar", string],
  ["vector", vector],
]);

const rejectAlternative: RejectParameter = (message) => {
  // oxlint-disable-next-line rules/require-tagged-error -- A branch failure is an internal control signal for the synchronous native converter.
  throw new TypeError(message);
};

const checkScalar = (name: string, value: unknown, context: RowValueContext): unknown => {
  const { dialect, fail, written } = context;
  const range = INTEGERS[name];
  if (range) {
    const checked = integer(value, { digits: name === "int8", range, truth: dialect !== "postgres", written }, fail);
    if (!WIDE_INTEGERS.has(name)) {return Number(checked);}
    return dialect === "postgres" ? checked.toString() : new Raw(checked.toString());
  }
  return (CHECKS.get(name) ?? generic)(value, context);
};

const alternative = (name: string, value: unknown, { dialect, fail, written }: RowValueContext): unknown => {
  const context = { dialect, fail: rejectAlternative, written };
  // oxlint-disable-next-line rules/no-for-loops -- Try conversions in declaration order and return immediately when the first one accepts the value.
  for (const part of name.split("|")) {
    try {
      return checkScalar(part, value, context);
    } catch {
      // A branch that refuses the value leaves all later alternatives available.
    }
  }
  return fail(`is ${written}; got ${describe(value)}.`);
};

export const scalar = (name: string, value: unknown, context: RowValueContext): unknown =>
  name.includes("|") ? alternative(name, value, context) : checkScalar(name, value, context);
