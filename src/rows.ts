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
import { isEmptyArray, isRecord, matchesNull, matchesString, matchesUndefined, nonemptyText } from "./native-predicates.ts";

import { wallClock } from "./row-clock.ts";
import { bigInteger, integer, INTEGERS, MYSQL_INTEGERS, unsignedRange } from "./row-numeric.ts";
import type { RejectParameter } from "./row-numeric.ts";
import { Raw, scalar } from "./row-scalar.ts";
import type { RowDialect, RowValueContext } from "./row-scalar.ts";

export { describe, zoned } from "./values.ts";

export type RowsType = Extract<EngineType, { kind: "rows" }>;
export type RowField = RowsType["fields"][number];

/** One comma-separated list of an insert's expansion, as UTF-16 offsets into the module's `text`: an entry per member, in the column list's order. */
export type StructuredList = Readonly<{ start: number; end: number; entries: Readonly<string[]> }>;
/** A structured parameter in insert position and the lists the run time writes again for the keys a call carries. */
export type Structured = Readonly<{ name: string; lists: Readonly<StructuredList[]> }>;

// Encode checked rows as JSON text, emitting a wide integer directly as its digits.
const write = function write(value: unknown): string {
  if (value instanceof Raw) {return value.text;}
  if (Array.isArray(value)) {return `[${value.map((element) => write(element)).join(",")}]`;}
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(([key, element]) => `${JSON.stringify(key)}:${write(element)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

interface PresentColumn {
  field: RowField;
  subject: string;
  value: unknown;
}

const checkedColumn = ({ field, subject, value }: PresentColumn, { dialect, fail }: ColumnCheck): unknown => {
  const checked = check(field.type, value, { dialect, fail: (message) => fail(`${subject} ${message}`), written: field.written });
  if (matchesUndefined(field.schema)) {return checked;}
  // A JSON member's schema fills its defaults and checks the value.
  const filled = withDefaults(field.schema, checked);
  const failure = validate(field.schema, filled);
  if (failure) {fail(`${subject}${failure.path ? ` at ${failure.path}` : ""} ${failure.message}.`);}
  return filled;
};

const presentColumn = ({ field, subject, value }: PresentColumn, context: ColumnCheck): unknown => {
  if (matchesNull(value)) {
    if (!field.nullable) {
      context.fail(`${subject} is ${field.written} not null, and the row gives null${field.optional ? "; leave the key out for the column's default" : ""}.`);
    }
    return value;
  }
  return checkedColumn({ field, subject, value }, context);
};

const checkColumnValue = (field: RowField, value: unknown, context: ColumnCheck): void => {
  const { fail, row, where } = context;
  const subject = `${where}"${field.name}"`;
  if (matchesUndefined(value)) {
    if (!field.optional) {fail(`${subject} is ${field.written} not null, and the row leaves it out.`);}
    return;
  }
  row.keys.add(field.name);
  const checked = presentColumn({ field, subject, value }, context);
  row.values[field.name] = checked;
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

const suppliedRows = (value: unknown, one: boolean, fail: RejectParameter): unknown[] => {
  if (matchesUndefined(value) || matchesNull(value)) {
    return fail(one ? "pass one object, whose keys the column list names." : "pass an array of objects, whose keys the column list names; an empty array inserts nothing.");
  }
  if (one) {return [value];}
  return Array.isArray(value) ? value : fail(`pass an array of objects, one per row; got ${describe(value)}.`);
};

interface CollectedRows {
  first?: InsertColumns;
  values: Record<string, unknown>[];
}

const collectRows = (rows: unknown[], schema: RowSchema, { inserted, type }: { inserted: boolean; type: RowsType }): CollectedRows => {
  const result: CollectedRows = { values: [] };
  rows.forEach((row, index) => {
    const rowNumber = index + firstRowNumber;
    const checked = checkRow(row, type.one ? "" : `row ${rowNumber}: `, schema);
    if (inserted) {
      const columns = { keys: checked.keys, rowNumber };
      if (matchesUndefined(result.first)) {result.first = columns;}
      else {verifyInsertColumns(result.first, columns, schema);}
    }
    result.values.push(checked.values);
  });
  return result;
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
// oxlint-disable-next-line eslint/max-params -- Preserve the synchronous structured parameter signature used by generated queries.
export const prepareRows = function prepareRows(name: string, type: RowsType, value: unknown, dialect: RowDialect, inserted: boolean): { value: unknown; present: ReadonlySet<string> } {
  const fail = (message: string): never => {
    throw new ParameterError(`Parameter "${name}": ${message}`);
  };
  const rows = suppliedRows(value, type.one, fail);
  const schema: RowSchema = {
    dialect, fail, fields: type.fields, known: new Map(type.fields.map((field) => [field.name, field])),
  };
  const { first, values } = collectRows(rows, schema, { inserted, type });
  const keys = first?.keys ?? new Set(type.fields.map((field) => field.name));
  if (inserted && !type.fields.some((field) => keys.has(field.name))) {fail("every key is left out, so the insert would name no column; give one at least.");}
  const shaped = type.one ? values[0] : values;
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the existing field order for serialized preparation results.
  return { value: dialect === "postgres" ? shaped : write(shaped), present: keys };
};

const castBase = (written: string): string => written.replace(/\s*\(.*$/u, "");

const castRange = (base: string, dialect: RowDialect): (typeof INTEGERS)[string] | undefined => {
  if (dialect === "sqlite") {return /[iI][nN][tT]/u.test(base) ? INTEGERS.integer : undefined;}
  return MYSQL_INTEGERS[nonemptyText(base.replace(/\s*unsigned$/u, "")) ?? "bigint"];
};

const isClock = (base: string): boolean => base === "date" || base === "time" || base === "datetime" || base === "timestamp";

const checkExplicitCast = (type: EngineType, value: unknown, context: RowValueContext): void => {
  const base = castBase(context.written);
  const signed = castRange(base, context.dialect);
  if (signed) {
    const range = context.dialect === "mysql" && base.endsWith("unsigned") ? unsignedRange(signed) : signed;
    integer(value, { digits: context.dialect === "mysql" && range[1] >= bigInteger[1], range, truth: true, written: context.written }, context.fail);
  } else if (base === "uuid") {
    scalar("uuid", value, context);
  } else if (context.dialect === "mysql" && isClock(base)) {
    wallClock(base, value, context);
  } else {
    check(type, value, context);
  }
};

/**
 * Checks the value of a parameter written `:p::type` on MySQL or SQLite, whose cast turns a value
 * it cannot read into 0 or NULL instead of failing (`CAST('abc' AS SIGNED)` is 0, and SQLite's
 * `CAST('1.9' AS INTEGER)` is 1), against the type as written, before the statement runs; the
 * value is bound as it is. `type` is the engine's type for the parameter. On SQLite every integer
 * is 64 bits, whatever the cast calls it.
 * @param {string} name The parameter being checked.
 * @param {string} written The cast type as it appears in SQL.
 * @param {EngineType} type The engine's type for the parameter.
 * @param {unknown} value The value supplied by the caller.
 * @param {RowDialect} dialect The database that consumes the parameter.
 */
// oxlint-disable-next-line eslint/max-params -- Preserve the parameter validation signature used by synchronous query execution.
export const checkCast = function checkCast(name: string, written: string, type: EngineType, value: unknown, dialect: RowDialect): void {
  if (matchesNull(value) || matchesUndefined(value)) {return;}
  const fail = (message: string): never => {
    throw new ParameterError(`Parameter "${name}" ${message}`);
  };
  checkExplicitCast(type, value, { dialect, fail, written });
};

const SQL_START = 0;

/**
 * Rewrites a MySQL statement's insert lists for the columns supplied by the caller.
 * @param {string} text The original SQL.
 * @param {Structured} structured The list spans stored in the generated query.
 * @param {Readonly<RowField[]>} fields The original columns in SQL order.
 * @param {ReadonlySet<string>} present The columns supplied by this call.
 * @returns {string} SQL containing every required and supplied optional column.
 */
// oxlint-disable-next-line eslint/max-params -- Preserve the existing structured query rewriting signature.
export const variant = function variant(text: string, structured: Structured, fields: Readonly<RowField[]>, present: ReadonlySet<string>): string {
  const lists = [...structured.lists].toSorted((left, right) => right.start - left.start);
  const output = { text };
  Iterator.from(lists).forEach((list) => {
    const kept = list.entries.filter((_entry, index) => {
      const field = fields[index];
      return matchesUndefined(field) || !field.optional || present.has(field.name);
    });
    output.text = output.text.slice(SQL_START, list.start) + kept.join(", ") + output.text.slice(list.end);
  });
  return output.text;
};
