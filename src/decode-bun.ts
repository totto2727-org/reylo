import { isEmptyArray, matchesNullish, matchesString } from "./native-predicates.ts";
import { coerce } from "./values.ts";
import type { Columns } from "./values.ts";

// Bun.sql can use native Date objects, typed arrays, and a driver's integer and binary forms.
const NATIVE_KINDS = /^(?:bool|int8|date|timestamp|timestamptz|interval|bytes|vector|hstore)$|\[\]$|\|/u;
const FIRST_ROW = 0;

const byType = (value: unknown, name: string): unknown => {
  if (value instanceof Date) {return coerce("timestamptz", value, name);}
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array) && !(value instanceof DataView)) {
    return coerce("float[]", value, name);
  }
  return value;
};

const applyColumns = (row: Record<string, unknown>, columns: Columns): void => {
  Iterator.from(columns).forEach(([name, kind, delimiter]) => {
    const value = row[name];
    if (matchesNullish(value)) {return;}
    if (kind === "unknown") {
      row[name] = byType(value, name);
      return;
    }
    // Bun.sql uses the decimal digits of a BIGINT when the MySQL expression's kind is a union.
    if (matchesString(value) && kind.includes("|") && kind.split("|").includes("int8") && /^[+-]?\d+$/u.test(value)) {
      row[name] = BigInt(value);
      return;
    }
    row[name] = coerce(kind, value, name, delimiter);
  });
};

const columnsFor = (first: Record<string, unknown> | undefined, columns: Columns | undefined): Columns =>
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Native result rows are dense and the caller checks for a nonempty result before inferring keys.
  columns ? columns.filter(([, kind]) => NATIVE_KINDS.test(kind)) : Object.keys(first!).map((name) => [name, "unknown"] as const);

/**
 * Normalizes the rows of a Bun.sql query to the generated kinds.
 * @param {unknown[]} rows - Bun.sql's result rows.
 * @param {Columns | undefined} columns - The compiled columns, when available.
 * @returns {unknown[]} The native rows, updated in place.
 */
export const bunRows = function bunRows(rows: unknown[], columns: Columns | undefined): unknown[] {
  if (!Array.isArray(rows)) {return [];}
  if (isEmptyArray(rows)) {return rows;}
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bun.sql supplies named result rows, including the first one used for a handwritten query.
  const records = rows as Record<string, unknown>[];
  const work = columnsFor(records[FIRST_ROW], columns);
  if (isEmptyArray(work)) {return rows;}
  Iterator.from(records).forEach((row) => {applyColumns(row, work);});
  return rows;
};
