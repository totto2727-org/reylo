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
import { describe, ParameterError } from "./values.ts";
import { isEmptyArray, isRecord, matchesNull, matchesString, matchesUndefined } from "./native-predicates.ts";

import { bigInteger, integer, INTEGERS, MYSQL_INTEGERS, unsignedRange } from "./row-numeric.ts";
import type { RejectParameter } from "./row-numeric.ts";
import { Raw, scalar, SINGLE_TYPE_MODIFIER } from "./row-scalar.ts";
import type { RowDialect, RowValueContext } from "./row-scalar.ts";

export { describe, zoned } from "./values.ts";

export type RowsType = Extract<EngineType, { kind: "rows" }>;
export type RowField = RowsType["fields"][number];

/** One comma-separated list of an insert's expansion, as UTF-16 offsets into the module's `text`: an entry per member, in the column list's order. */
export type StructuredList = Readonly<{ start: number; end: number; entries: Readonly<string[]> }>;
/** A structured parameter in insert position and the lists the run time writes again for the keys a call carries. */
export type Structured = Readonly<{ name: string; lists: Readonly<StructuredList[]> }>;

/** The checked rows as JSON text, a 64-bit integer as its digits. */
const write = function write(v: unknown): string {
  if (v instanceof Raw) {return v.text;}
  if (Array.isArray(v)) {return `[${v.map(write).join(",")}]`;}
  if (isRecord(v)) {
    return `{${Object.entries(v)
      .map(([key, value]) => `${JSON.stringify(key)}:${write(value)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
};

const firstRowNumber = 1;

interface RowSchema {
  dialect: RowDialect;
  fail: RejectParameter;
  fields: RowsType["fields"];
  known: ReadonlyMap<string, RowField>;
}

interface CheckedRow {
  keys: Set<string>;
  values: Record<string, unknown>;
}

interface ColumnCheck {
  dialect: RowDialect;
  fail: RejectParameter;
  row: CheckedRow;
  where: string;
}

const checkJson = (value: unknown, { fail, written }: RowValueContext): unknown => {
  // JSON.stringify rejects BigInt, and returns undefined for values such as functions.
  try {
    if (matchesUndefined(JSON.stringify(value))) {fail(`is ${written}, which holds a JSON value; got ${describe(value)}.`);}
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Keep the raw message property of exceptions thrown by a caller's toJSON method.
    fail(`is ${written}, which holds a JSON value: ${(error as Error).message}.`);
  }
  return value;
};

const checkEnum = (type: Extract<EngineType, { kind: "enum" }>, value: unknown, { fail }: RowValueContext): unknown => {
  if (matchesString(value) && (isEmptyArray(type.labels) || type.labels.includes(value))) {return value;}
  return fail(`is the enum ${type.name}, one of ${type.labels.map((label) => JSON.stringify(label)).join(", ")}; got ${describe(value)}.`);
};

const check = (type: EngineType, value: unknown, context: RowValueContext): unknown => {
  if (type.kind === "json") {return checkJson(value, context);}
  if (type.kind === "enum") {return checkEnum(type, value, context);}
  if (type.kind === "array") {
    if (!Array.isArray(value)) {return context.fail(`is ${context.written}, an array; got ${describe(value)}.`);}
    const element = context.written.replace(/\s*\[\s*\]\s*$/u, "");
    return value.map((member, index) => matchesNull(member) ? member : check(type.of, member, {
      dialect: context.dialect,
      fail: (message) => context.fail(`element ${index + firstRowNumber} ${message}`),
      written: element,
    }));
  }
  return type.kind === "scalar" ? scalar(type.name, value, context) : value;
};

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
  const checked = check(field.type, value, { dialect, fail: (message) => fail(`${subject} ${message}`), written: field.written });
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
 * @param {RowDialect} dialect - The database that consumes the rows.
 * @param {boolean} inserted - Whether every row must supply the same insert columns.
 * @returns {{ value: unknown; present: ReadonlySet<string> }} The bound value and supplied column names.
 */
export const prepareRows = function prepareRows(name: string, type: RowsType, value: unknown, dialect: RowDialect, inserted: boolean): { value: unknown; present: ReadonlySet<string> } {
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
};

const CLOCK = /^-?(?<hours>\d{1,3}):(?<minutes>\d{2})(?::(?<seconds>\d{2})(?:\.(?<fraction>\d+))?)?$/u;
const WALL_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:[T ](?<hours>\d{2}):(?<minutes>\d{2})(?::(?<seconds>\d{2})(?:\.(?<fraction>\d+))?)?)?$/u;
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
  const digits = SINGLE_TYPE_MODIFIER.exec(written)?.groups?.digits;
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
export const checkCast = function checkCast(name: string, written: string, type: EngineType, v: unknown, dialect: RowDialect): void {
  if (matchesNull(v) || matchesUndefined(v)) {return;}
  const fail = (message: string): never => {
    throw new ParameterError(`Parameter "${name}" ${message}`);
  };
  const base = written.replace(/\s*\(.*$/, "");
  const signed = dialect === "sqlite" ? (/int/i.test(base) ? INTEGERS.integer : undefined) : MYSQL_INTEGERS[base.replace(/\s*unsigned$/u, "") || "bigint"];
  if (signed) {
    const range = dialect === "mysql" && base.endsWith("unsigned") ? unsignedRange(signed) : signed;
    integer(v, { digits: dialect === "mysql" && range[1] >= bigInteger[1], range, truth: true, written }, fail);
    return;
  }
  if (base === "uuid") {
    scalar("uuid", v, { dialect, fail, written });
    return;
  }
  if (dialect === "mysql" && (base === "date" || base === "time" || base === "datetime" || base === "timestamp")) {
    wallClock(base, written, v, fail);
    return;
  }
  check(type, v, { dialect, fail, written });
};

/** The statement with each list of a structured parameter written again for the keys present (MySQL): an entry stays when its key is required or present. */
export const variant = function variant(text: string, structured: Structured, fields: Readonly<RowField[]>, present: ReadonlySet<string>): string {
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
};
