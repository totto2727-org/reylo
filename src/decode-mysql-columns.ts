import { isEmptyArray, matchesBigInt, matchesNullish, matchesNumber, matchesString } from "./native-predicates.ts";
import { bigInteger, coerce, truth } from "./values.ts";
import type { Columns, Kind } from "./values.ts";

export type DriverRow = Record<string, unknown>;
type ColumnFix = Readonly<[string, Fix]>;

/** What a column's values need after a driver: a truth value made a boolean, a BIGINT a BigInt. */
export type Fix = (value: unknown, name: string) => unknown;
// A BIGINT's text is always its digits: BigInt reads it straight.
export const toBigInt: Fix = (value, name) => {
  if (matchesString(value)) {return BigInt(value);}
  return matchesNumber(value) || matchesBigInt(value) ? bigInteger(value, name) : value;
};

// A VECTOR is MySQL's one array: mysql2 decodes its floats, mariadb and PlanetScale give its bytes.
const toFloats: Fix = (value, name) => coerce("float[]", value, name);

// A boolean, widened integer, or vector can need decoding after the driver.
export const byKind = function (kind: Kind | undefined): Fix | undefined {
  if (kind === "bool") {return truth;}
  if (kind === "int8") {return toBigInt;}
  if (kind === "float[]") {return toFloats;}
  return undefined;
};

// Apply the fixes in order. The drivers build fresh rows for each call.
export const fixRows = function (rows: DriverRow[], fixes: Readonly<ColumnFix[]>): void {
  if (isEmptyArray(fixes)) {return;}
  Iterator.from(rows).forEach((row) => {
    fixes.forEach(([name, fix]) => {
      const value = row[name];
      if (!matchesNullish(value)) {row[name] = fix(value, name);}
    });
  });
};

// A result with generated kinds can use the same conversions on every MySQL driver.
export const columnFixes = function columnFixes(columns: Columns | undefined): ColumnFix[] {
  const fixes: ColumnFix[] = [];
  Iterator.from(columns ?? []).forEach(([name, kind]) => {
    const fix = byKind(kind);
    if (fix) {fixes.push([name, fix]);}
  });
  return fixes;
};
