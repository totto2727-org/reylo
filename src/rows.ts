// Structured parameters at run time (wiki/structured-params.md): the value of a `:events::rows(…)`
// Or `:user::row(…)` parameter is checked against its column list before the statement runs, and
// Written as the JSON the statement reads. A key a row leaves out takes its column's default: on
// Postgres and SQLite the statement holds each such default, copied from the catalog, so it is one
// Text whatever keys the rows give; on MySQL an insert's column lists are
// Written again without the keys a call leaves out, so every row of a call gives the same keys.
// Nothing here changes a value: a value the database would round, truncate or read in a zone
// Nobody chose is refused.
import type { EngineType } from "./engine-type.ts";
import { validate, withDefaults } from "./json-schema.ts";
import { describe, hstoreText, ParameterError, postgresInterval, postgresYear, zoned } from "./values.ts";
import { hasObjectType, isRecord, matchesBigInt, matchesBoolean, matchesNull, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";

export { describe, zoned } from "./values.ts";

type Dialect = "postgres" | "mysql" | "sqlite" | "duckdb";
export type RowsType = Extract<EngineType, { kind: "rows" }>;
export type RowField = RowsType["fields"][number];

/** One comma-separated list of an insert's expansion, as UTF-16 offsets into the module's `text`: an entry per member, in the column list's order. */
export type StructuredList = Readonly<{ start: number; end: number; entries: Readonly<string[]> }>;
/** A structured parameter in insert position and the lists the run time writes again for the keys a call carries. */
export type Structured = Readonly<{ name: string; lists: Readonly<StructuredList[]> }>;

// BigInt calls, not literals: a project that type-checks these sources for a target below ES2020
// Refuses a literal (TS2737), as lab/nextjs's ES2017 does.
const zero = BigInt(0);
const one = BigInt(1);
const two = BigInt(2);
const signBits = 1;
const tinyIntegerBits = 8;
const smallIntegerBits = 16;
const mediumIntegerBits = 24;
const integerBits = 32;
const bigIntegerBits = 64;

type IntegerRange = Readonly<[minimum: bigint, maximum: bigint]>;

const signedRange = (bits: number): IntegerRange => {
  const ceiling = two ** BigInt(bits - signBits);
  return [-ceiling, ceiling - one];
};

const tinyInteger = signedRange(tinyIntegerBits);
const smallInteger = signedRange(smallIntegerBits);
const mediumInteger = signedRange(mediumIntegerBits);
const standardInteger = signedRange(integerBits);
const bigInteger = signedRange(bigIntegerBits);

const INTEGERS: Record<string, IntegerRange> = {
  int2: smallInteger,
  int4: standardInteger,
  int8: bigInteger,
  // SQLite's INTEGER is also a signed 64-bit integer.
  integer: bigInteger,
};
const WIDE = new Set(["int8", "integer"]);

/** Raw JSON text for a value the writer puts in as it is. */
class Raw {
  public readonly text: string;
  public constructor(text: string) {
    this.text = text;
  }
}

/** The checked rows as JSON text, a 64-bit integer as its digits. */
const write = function write(v: unknown): string {
  if (v instanceof Raw) {return v.text;}
  if (Array.isArray(v)) {return `[${v.map(write).join(",")}]`;}
  if (isRecord(v)) {
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}:${write(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
};

const firstRowNumber = 1;

type RejectParameter = (message: string) => never;

interface RowSchema {
  dialect: Dialect;
  fail: RejectParameter;
  fields: RowsType["fields"];
  known: ReadonlyMap<string, RowField>;
}

interface CheckedRow {
  keys: Set<string>;
  values: Record<string, unknown>;
}

interface ColumnCheck {
  dialect: Dialect;
  fail: RejectParameter;
  row: CheckedRow;
  where: string;
}

const checkColumnValue = (field: RowField, value: unknown, context: ColumnCheck): void => {
  const { dialect, fail, row, where } = context;
  const subject = `${where}"${field.name}"`;
  if (matchesUndefined(value)) {
    if (!field.optional) {fail(`${subject} is ${field.written} not null, and the row leaves it out.`);}
    return;
  }
  row.keys.add(field.name);
  if (matchesNull(value)) {
    if (!field.nullable) {fail(`${subject} is ${field.written} not null, and the row gives null${field.optional ? "; leave the key out for the column's default" : ""}.`);}
    row.values[field.name] = null;
    return;
  }
  const checked = check(field.type, field.written, value, dialect, (message) => fail(`${subject} ${message}`));
  if (matchesUndefined(field.schema)) {
    row.values[field.name] = checked;
    return;
  }
  // A JSON member's schema fills its defaults and checks the value (wiki/typed-json-params.md).
  const filled = withDefaults(field.schema, checked);
  const failure = validate(field.schema, filled);
  if (failure) {fail(`${subject}${failure.path ? ` at ${failure.path}` : ""} ${failure.message}.`);}
  row.values[field.name] = filled;
};

const checkRow = (value: unknown, where: string, schema: RowSchema): CheckedRow => {
  const { dialect, fail, fields, known } = schema;
  if (!isRecord(value) || value instanceof Date) {
    return fail(`${where}each row is an object whose keys the column list names; got ${describe(value)}.`);
  }
  Object.keys(value).forEach((key) => {
    if (!known.has(key) && !matchesUndefined(value[key])) {
      fail(`${where}the column list names no key "${key}" (it names ${fields.map((field) => `"${field.name}"`).join(", ")}).`);
    }
  });
  const row: CheckedRow = { keys: new Set(), values: {} };
  const context: ColumnCheck = { dialect, fail, row, where };
  Iterator.from(fields).forEach((field) => {
    checkColumnValue(field, value[field.name], context);
  });
  return row;
};

interface InsertColumns {
  keys: Set<string>;
  rowNumber: number;
}

const verifyInsertColumns = (expected: InsertColumns, actual: InsertColumns, schema: RowSchema): void => {
  const differ = schema.fields.find((field) => expected.keys.has(field.name) !== actual.keys.has(field.name));
  if (matchesUndefined(differ)) {return;}
  const givesKey = actual.keys.has(differ.name);
  schema.fail(`row ${actual.rowNumber} ${givesKey ? "gives" : "leaves out"} "${differ.name}", which row ${expected.rowNumber} ${givesKey ? "leaves out" : "gives"}. Every row of one call gives the same keys, since one insert writes them all and a key left out takes its column's default: give "${differ.name}" in every row, or in none.`);
};

/**
 * Checks a structured parameter and produces the JSON value or text to bind.
 * @param {string} name - The structured parameter's name.
 * @param {RowsType} type - Its declared column list.
 * @param {unknown} value - The supplied row or rows.
 * @param {Dialect} dialect - The database that consumes the rows.
 * @param {boolean} inserted - Whether every row must supply the same insert columns.
 * @returns {{ value: unknown; present: ReadonlySet<string> }} The bound value and supplied column names.
 */
export function prepareRows(name: string, type: RowsType, value: unknown, dialect: Dialect, inserted: boolean): { value: unknown; present: ReadonlySet<string> } {
  const fail = (message: string): never => {
    throw new ParameterError(`Parameter "${name}": ${message}`);
  };
  if (matchesUndefined(value) || matchesNull(value)) {fail(type.one ? "pass one object, whose keys the column list names." : "pass an array of objects, whose keys the column list names; an empty array inserts nothing.");}
  const rows = type.one ? [value] : (Array.isArray(value) ? value : fail(`pass an array of objects, one per row; got ${describe(value)}.`));
  const schema: RowSchema = {
    dialect, fail, fields: type.fields, known: new Map(type.fields.map((field) => [field.name, field])),
  };
  // oxlint-disable-next-line rules/no-let -- An insert compares later rows with the first row it received.
  let first: InsertColumns | undefined;
  const out: Record<string, unknown>[] = [];
  rows.forEach((row: unknown, index: number) => {
    const rowNumber = index + firstRowNumber;
    const checked = checkRow(row, type.one ? "" : `row ${rowNumber}: `, schema);
    if (inserted) {
      const columns = { keys: checked.keys, rowNumber };
      if (matchesUndefined(first)) {first = columns;}
      else {verifyInsertColumns(first, columns, schema);}
    }
    out.push(checked.values);
  });
  const keys = first?.keys ?? new Set(type.fields.map((field) => field.name));
  if (inserted && !type.fields.some((field) => keys.has(field.name))) {fail("every key is left out, so the insert would name no column; give one at least.");}
  const shaped = type.one ? out[0] : out;
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the existing field order for serialized preparation results.
  return { value: dialect === "postgres" ? shaped : write(shaped), present: keys };
}

/** One value checked against its type, as the JSON the database reads; `fail` says why not. */
function check(type: EngineType, written: string, v: unknown, dialect: Dialect, fail: (message: string) => never): unknown {
  switch (type.kind) {
    case "json": {
      // JSON.stringify throws on a BigInt and skips a function; a JSON member holds JSON.
      try {
        if (matchesUndefined(JSON.stringify(v))) {fail(`is ${written}, which holds a JSON value; got ${describe(v)}.`);}
      } catch (error) {
        fail(`is ${written}, which holds a JSON value: ${(error as Error).message}.`);
      }
      return v;
    }
    case "enum": {
      if (matchesString(v) && (type.labels.length === 0 || type.labels.includes(v))) {return v;}
      return fail(`is the enum ${type.name}, one of ${type.labels.map((label) => JSON.stringify(label)).join(", ")}; got ${describe(v)}.`);
    }
    case "array": {
      if (!Array.isArray(v)) {return fail(`is ${written}, an array; got ${describe(v)}.`);}
      const element = written.replace(/\s*\[\s*\]\s*$/u, "");
      return v.map((e, index) => (matchesNull(e) ? null : check(type.of, element, e, dialect, (message) => fail(`element ${index + 1} ${message}`))));
    }
    case "scalar": {
      return scalar(type.name, written, v, dialect, fail);
    }
    default: {
      return v;
    }
  }
}

function scalar(name: string, written: string, v: unknown, dialect: Dialect, fail: (message: string) => never): unknown {
  // `a|b` is either, where the database decides by the value.
  if (name.includes("|")) {
    for (const part of name.split("|")) {
      try {
        return scalar(part, written, v, dialect, (message) => {
          throw new TypeError(message);
        });
      } catch {}
    }
    return fail(`is ${written}; got ${describe(v)}.`);
  }
  const range = INTEGERS[name];
  if (range) {
    const n = integer(range, name === "int8", written, v, fail, dialect !== "postgres");
    if (!WIDE.has(name)) {return Number(n);}
    return dialect === "postgres" ? n.toString() : new Raw(n.toString());
  }
  switch (name) {
    case "float4":
    case "float8":
    case "real": {
      if (matchesNumber(v) && Number.isFinite(v)) {return v;}
      return fail(`is ${written}, a finite number; got ${describe(v)}.`);
    }
    case "numeric": {
      return decimal(written, v, fail);
    }
    case "bool": {
      if (matchesBoolean(v)) {return v;}
      return fail(`is ${written}, true or false; got ${describe(v)}.`);
    }
    case "text":
    case "varchar":
    case "bpchar":
    case "char":
    case "name":
    case "citext": {
      if (!matchesString(v)) {return fail(`is ${written}, a string; got ${describe(v)}.`);}
      const n = /\(\s*(\d+)\s*\)/u.exec(written)?.[1];
      // A length counts characters (code points), as Postgres and MySQL count them.
      if (!matchesUndefined(n) && [...v].length > Number(n)) {fail(`is ${written}, at most ${n} characters; got ${[...v].length}, which the database would refuse or cut.`);}
      return v;
    }
    case "vector":
    case "halfvec": {
      // Pgvector's vector, as `.run()` returns it, written as the text its input reads.
      if (Array.isArray(v) && v.length > 0 && v.every((e) => matchesNumber(e) && Number.isFinite(e))) {return JSON.stringify(v);}
      if (matchesString(v)) {return v;}
      return fail(`is ${written}, an array of finite numbers with one at least; got ${describe(v)}.`);
    }
    case "hstore": {
      // An hstore, as `.run()` returns it, written as the text its input reads.
      if (!matchesNull(v) && hasObjectType(v)) {return hstoreText(v, (message) => fail(message.replace(/^is an hstore/u, `is ${written}`)));}
      if (matchesString(v)) {return v;}
      return fail(`is ${written}, an object of its keys whose values are strings or null; got ${describe(v)}.`);
    }
    case "uuid": {
      if (matchesString(v) && /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i.test(v)) {return v;}
      return fail(`is ${written}, a UUID in hexadecimal; got ${describe(v)}.`);
    }
    case "timestamptz": {
      // A string that names its zone, as `.run()` returns one; no Date.
      if (v instanceof Date) {return fail(`is ${written}, which takes the instant as a string that names its zone, not a Date: pass date.toISOString() ("2026-10-12T19:06:48.282Z").`);}
      if (matchesString(v) && zoned.test(v.trim())) {return dialect === "postgres" ? postgresYear(v) : v;}
      return fail(`is ${written}, an instant: a string that names its zone ("2026-10-12T19:06:48.282Z", "2026-10-12 19:06:48+09"); got ${describe(v)}, which the server would read in the session's time zone.`);
    }
    case "timestamp":
    case "date": {
      if (matchesString(v)) {return dialect === "postgres" ? postgresYear(v) : v;}
      return fail(`is ${written}, a wall-clock reading with no zone, which takes its text ("2026-10-12 19:06:48.282", "2026-10-12"), not a Date: drivers write a Date's time in different zones.${v instanceof Date ? "" : ` Got ${describe(v)}.`}`);
    }
    case "bytea":
    case "blob": {
      // Binary data travels as hexadecimal text: Postgres's own `\x` form, and bare digits that
      // MySQL's and SQLite's readers decode with unhex().
      if (!(v instanceof Uint8Array)) {return fail(`is ${written}, binary data, a Uint8Array; got ${describe(v)}.`);}
      const n = /\(\s*(\d+)\s*\)/u.exec(written)?.[1];
      if (!matchesUndefined(n) && v.length > Number(n)) {fail(`is ${written}, at most ${n} bytes; got ${v.length}, which the database would refuse or cut.`);}
      let hex = dialect === "postgres" ? String.raw`\x` : "";
      Iterator.from(v).forEach((byte) => {hex += (byte < 16 ? "0" : "") + byte.toString(16);});
      return hex;
    }
    case "interval": {
      // `-P1D`, as `.run()` returns a negative interval, in the form Postgres reads.
      if (matchesString(v)) {return postgresInterval(v);}
      if (matchesNumber(v)) {return v;}
      return fail(`is ${written}; got ${describe(v)}.`);
    }
    default: {
      // A type the run time has no rule for (time, inet, …) takes the text the database reads, and
      // A number or a truth value as JSON writes them.
      if (matchesString(v) || matchesNumber(v) || matchesBoolean(v)) {return v;}
      return fail(`is ${written}; got ${describe(v)}.`);
    }
  }
}

/** An integer in `range`, as a number, a BigInt or, where `digits`, a string of its digits. */
/**
 * `truth`: MySQL and SQLite, where a truth value is an integer, and a TINYINT(1), BIT(1) or BOOLEAN
 * column returns a boolean, which goes back in as 1 or 0 (the round-trip rule, src/render.ts).
 */
function integer(range: Readonly<[bigint, bigint]>, digits: boolean, written: string, v: unknown, fail: (message: string) => never, truth = false): bigint {
  let n: bigint;
  if (matchesBigInt(v)) {n = v;}
  else if (matchesBoolean(v) && truth) {n = BigInt(v ? 1 : 0);}
  else if (matchesNumber(v) && Number.isInteger(v)) {
    if (!Number.isSafeInteger(v)) {fail(`is ${written}; ${v} is past 2^53 - 1, where a number stops being exact, so pass it as a BigInt${digits ? " or a string of digits" : ""}.`);}
    n = BigInt(v);
  } else if (matchesString(v) && /^[+-]?\d+$/u.test(v.trim()) && digits) {n = BigInt(v.trim());}
  else {return fail(`is ${written}, an integer; got ${describe(v)}.`);}
  if (n < range[0] || n > range[1]) {fail(`is ${written}, from ${range[0]} to ${range[1]}; got ${n}.`);}
  return n;
}

/** MySQL's integer types as a `::` cast names them, each with its range; `unsigned` doubles it from 0. */
const MYSQL_INTEGERS: Record<string, IntegerRange> = {
  bigint: bigInteger,
  int: standardInteger,
  int2: smallInteger,
  int4: standardInteger,
  int8: bigInteger,
  integer: standardInteger,
  mediumint: mediumInteger,
  signed: bigInteger,
  smallint: smallInteger,
  tinyint: tinyInteger,
};

const CLOCK = /^-?(?<hours>\d{1,3}):(?<minutes>\d{2})(?::(?<seconds>\d{2})(?:\.(?<fraction>\d+))?)?$/u;
const WALL_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:[T ](?<hours>\d{2}):(?<minutes>\d{2})(?::(?<seconds>\d{2})(?:\.(?<fraction>\d+))?)?)?$/u;
const FRACTION = /\(\s*(?<digits>\d+)\s*\)/u;
const NO_FRACTION = 0;
const DATETIME_FRACTION_DIGITS = 6;
const MYSQL_TIME_HOUR_LIMIT = 838;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const ZERO_CLOCK_PART = 0;
const FIRST_MONTH = 1;
const LAST_MONTH = 12;
const FIRST_DAY_OF_MONTH = 1;
const LAST_DAY_OF_PREVIOUS_MONTH = 0;

type ClockFields = Record<string, string | undefined>;

const validClock = (parts: ClockFields, keeps: number): boolean =>
  Number(parts.minutes ?? ZERO_CLOCK_PART) < MINUTES_PER_HOUR &&
  Number(parts.seconds ?? ZERO_CLOCK_PART) < SECONDS_PER_MINUTE &&
  (parts.fraction ?? "").length <= keeps;

const validMysqlTime = (text: string, keeps: number): boolean => {
  const parts = CLOCK.exec(text)?.groups;
  return !matchesUndefined(parts) && Number(parts.hours) <= MYSQL_TIME_HOUR_LIMIT && validClock(parts, keeps);
};

const validMysqlDate = (text: string, base: string, keeps: number): boolean => {
  const parts = WALL_DATE.exec(text)?.groups;
  if (matchesUndefined(parts)) {return false;}
  const month = Number(parts.month);
  const day = Number(parts.day);
  const days = new Date(Date.UTC(Number(parts.year), month, LAST_DAY_OF_PREVIOUS_MONTH)).getUTCDate();
  if (month < FIRST_MONTH || month > LAST_MONTH || day < FIRST_DAY_OF_MONTH || day > days) {return false;}
  if (base === "date") {return matchesUndefined(parts.hours);}
  return Number(parts.hours ?? ZERO_CLOCK_PART) < HOURS_PER_DAY && validClock(parts, keeps);
};

/** Check whether MySQL would round or discard any part of a date, time or date-time. */
const wallClock = (base: string, written: string, value: unknown, fail: RejectParameter): void => {
  const example = base === "date" ? '"2026-10-12"' : (base === "time" ? '"19:06:48"' : '"2026-10-12 19:06:48.282"');
  if (!matchesString(value)) {return void fail(`is ${written}, which takes its text (${example}), not ${describe(value)}${value instanceof Date ? ": drivers write a Date's time in different zones" : ""}.`);}
  const text = value.trim();
  const digits = FRACTION.exec(written)?.groups?.digits;
  const keeps = Number(digits ?? (base === "time" ? NO_FRACTION : DATETIME_FRACTION_DIGITS));
  if (base === "time" ? validMysqlTime(text, keeps) : validMysqlDate(text, base, keeps)) {return;}
  const precision = keeps > NO_FRACTION && base !== "date" ? ` with at most ${keeps} digits after the second's point` : (base === "time" ? " with no fraction of a second" : "");
  fail(`is ${written}, as text like ${example}${precision}; got ${describe(value)}, which MySQL's CAST would make NULL or change.`);
};

/**
 * Checks the value of a parameter written `:p::type` on MySQL or SQLite, whose cast turns a value
 * it cannot read into 0 or NULL instead of failing (`CAST('abc' AS SIGNED)` is 0, and SQLite's
 * `CAST('1.9' AS INTEGER)` is 1), against the type as written, before the statement runs; the
 * value is bound as it is. `type` is the engine's type for the parameter. On SQLite every integer
 * is 64 bits, whatever the cast calls it.
 */
export function checkCast(name: string, written: string, type: EngineType, v: unknown, dialect: Dialect): void {
  if (matchesNull(v) || matchesUndefined(v)) {return;}
  const fail = (message: string): never => {
    throw new ParameterError(`Parameter "${name}" ${message}`);
  };
  const base = written.replace(/\s*\(.*$/, "");
  const signed = dialect === "sqlite" ? (/int/i.test(base) ? INTEGERS.integer : undefined) : MYSQL_INTEGERS[base.replace(/\s*unsigned$/u, "") || "bigint"];
  if (signed) {
    const range: Readonly<[bigint, bigint]> = dialect === "mysql" && base.endsWith("unsigned") ? [zero, signed[1] * two + one] : signed;
    integer(range, dialect === "mysql" && range[1] >= bigInteger[1], written, v, fail, true);
    return;
  }
  if (base === "uuid") {
    scalar("uuid", written, v, dialect, fail);
    return;
  }
  if (dialect === "mysql" && (base === "date" || base === "time" || base === "datetime" || base === "timestamp")) {
    wallClock(base, written, v, fail);
    return;
  }
  check(type, written, v, dialect, fail);
}

/**
 * A decimal, as a number or as its digits. `numeric(p,s)` keeps `s` digits after the point and
 * `p` in all: a value with more decimals would be rounded, so it is refused, and so is one with
 * more digits before the point than the column holds.
 */
function decimal(written: string, v: unknown, fail: (message: string) => never): unknown {
  let text: string;
  if (matchesNumber(v)) {
    if (!Number.isFinite(v)) {return fail(`is ${written}, a finite decimal; got ${v}.`);}
    text = String(v);
  } else if (matchesString(v)) {text = v.trim();}
  else if (matchesBigInt(v)) {text = v.toString();}
  else {return fail(`is ${written}, a decimal: a number or a string of its digits; got ${describe(v)}.`);}
  const regexMatch = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!regexMatch || (regexMatch[2] === "" && (regexMatch[3] ?? "") === "")) {return fail(`is ${written}, a decimal: a number or a string of its digits; got ${describe(v)}.`);}
  const mod = /\(\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\)/u.exec(written);
  if (mod) {
    const precision = Number(mod[1]);
    const scale = Number(mod[2] ?? 0);
    const exponent = Number(regexMatch[4] ?? 0);
    let whole = (regexMatch[2] ?? "").replace(/^0+/u, "");
    let fraction = (regexMatch[3] ?? "").replace(/0+$/u, "");
    // Shift the point by the exponent.
    if (exponent > 0) {
      const moved = fraction.slice(0, exponent).padEnd(exponent, "0");
      whole = (whole + moved).replace(/^0+/u, "");
      fraction = fraction.slice(exponent);
    } else if (exponent < 0) {
      const digits = whole.padStart(-exponent, "0");
      fraction = (digits.slice(digits.length + exponent) + fraction).replace(/0+$/u, "");
      whole = digits.slice(0, digits.length + exponent).replace(/^0+/u, "");
    }
    if (fraction.length > scale) {fail(`is ${written}, which keeps ${scale} digit${scale === 1 ? "" : "s"} after the point, so ${text} would be rounded.`);}
    if (whole.length > precision - scale) {fail(`is ${written}, which holds at most ${precision - scale} digit${precision - scale === 1 ? "" : "s"} before the point; got ${text}.`);}
  }
  return matchesBigInt(v) ? v.toString() : v;
}

/** The statement with each list of a structured parameter written again for the keys present (MySQL): an entry stays when its key is required or present. */
export function variant(text: string, structured: Structured, fields: Readonly<RowField[]>, present: ReadonlySet<string>): string {
  const lists = [...structured.lists].sort((left, right) => right.start - left.start);
  let out = text;
  Iterator.from(lists).forEach((list) => {
    const kept = list.entries.filter((entry, index) => {
      const f = fields[index];
      return matchesUndefined(f) || !f.optional || present.has(f.name);
    });
    out = out.slice(0, list.start) + kept.join(", ") + out.slice(list.end);
  });
  return out;
}
