import { hasObjectType, isEmptyArray, matchesBigInt, matchesNull, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import { jsonValue } from "./value-text.ts";
import { bigInteger, coerce, DecodeError, exactInteger, refuseTruth, truth } from "./values.ts";
import type { Columns, Kind } from "./values.ts";

interface Plan {
  blob?: ((value: object) => never) | undefined;
  big: (value: bigint) => unknown;
  name: string;
  num: ((value: number) => unknown) | undefined;
  str: ((value: string) => unknown) | undefined;
}

const DIGITS = /^[+-]?\d+$/u;
const NUMERIC_AFFINITY_PARTS = 3;
const FIRST_CHARACTER = 0;
const TEXT_PREVIEW = 40;
const ONE_BYTE = 1;
const NO_BYTES = 0;
const FIRST_ROW = 0;

const TYPE_NAMES: Readonly<Record<string, string>> = {
  bytes: "Uint8Array", float: "number", int: "number", int8: "bigint", text: "string",
};

const byteLength = (value: unknown): number => {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {return value.byteLength;}
  return Array.isArray(value) ? value.length : NO_BYTES;
};

const heldValue = (value: unknown): string => {
  if (matchesString(value)) {
    const preview = value.length > TEXT_PREVIEW ? `${value.slice(FIRST_CHARACTER, TEXT_PREVIEW)}…` : value;
    return `the text ${JSON.stringify(preview)}`;
  }
  if (matchesNumber(value) || matchesBigInt(value)) {return `the number ${value}`;}
  const length = byteLength(value);
  return `a BLOB of ${length} byte${length === ONE_BYTE ? "" : "s"}`;
};

// Outside STRICT tables, SQLite can store a value from another storage class in a typed column.
const refuseClass = (column: string, kinds: Readonly<string[]>, value: unknown): never => {
  const type = [...new Set(kinds.map((kind) => TYPE_NAMES[kind] ?? kind))].join(" | ");
  throw new DecodeError(
    `Column "${column}" is typed ${type} and holds ${heldValue(value)}: outside a STRICT table SQLite stores a value of any type in any column, and Reylo refuses one its type does not allow rather than return it. Replace the value, or read what the column holds with cast(${column} as text).`,
  );
};

type Refusal = (value: unknown) => never;

interface ColumnPlan {
  blob: ((value: object) => never) | undefined;
  exact: boolean;
  name: string;
  refuse: Refusal;
}

const truthPlan = (name: string): Plan => ({
  big: (value) => truth(value, name),
  blob: () => refuseTruth(name, "a BLOB"),
  name,
  num: (value) => truth(value, name),
  str: (value) => truth(value, name),
});

const ownedScalar = (kind: Kind, { blob, exact, name, refuse }: ColumnPlan): Plan | undefined => {
  // BIGINT remains a BigInt. A rounded driver number or a REAL cannot recover an exact integer.
  if (kind === "int8") {
    return {
      big: (value) => value,
      blob,
      name,
      num: exact ? refuse : (value) => Number.isInteger(value) ? bigInteger(value, name) : refuse(value),
      str: (value) => DIGITS.test(value) ? BigInt(value) : refuse(value),
    };
  }
  if (kind === "text") {return { big: String, blob, name, num: undefined, str: undefined };}
  if (kind === "int") {
    const integer = (value: bigint | number): number => exactInteger(value, name);
    return {
      big: integer,
      blob,
      name,
      num: exact ? undefined : integer,
      str: (value) => DIGITS.test(value) ? integer(BigInt(value)) : refuse(value),
    };
  }
  return undefined;
};

const numericOnly = (kinds: Readonly<string[]>): boolean =>
  kinds.every((kind) => kind === "int" || kind === "float")
  || (kinds.length === NUMERIC_AFFINITY_PARTS && kinds.includes("int") && kinds.includes("float") && kinds.includes("text"));

interface StorageClasses {
  numbers: boolean;
  texts: boolean;
}

const mixedText = (kinds: Readonly<string[]>, { numbers, texts }: StorageClasses, { name, refuse }: ColumnPlan): Plan["str"] => {
  // LibSQL can return an INTEGER as its digits. In REAL and NUMERIC columns,
  // Text containing an integer represents an INTEGER because the affinity converts it.
  if (numericOnly(kinds) || (numbers && !texts)) {
    return (value) => {
      if (DIGITS.test(value)) {return exactInteger(BigInt(value), name);}
      return texts ? value : refuse(value);
    };
  }
  return texts ? undefined : refuse;
};

const mixedPlan = (kinds: Readonly<string[]>, classes: StorageClasses, format: ColumnPlan): Plan => {
  const { blob, exact, name, refuse } = format;
  const str = mixedText(kinds, classes, format);
  const big = (value: bigint): number => exactInteger(value, name);
  // Without exact integer reads, a NUMERIC value past 2^53 may be a rounded INTEGER.
  if (!exact && kinds.includes("int")) {
    return { big, blob, name, num: (value) => Number.isInteger(value) ? exactInteger(value, name) : value, str };
  }
  if (!classes.numbers && !classes.texts) {return { big: refuse, blob, name, num: refuse, str };}
  return { big, blob, name, num: undefined, str };
};

const storageClasses = (kinds: Readonly<string[]>, permitsAll: boolean): StorageClasses => ({
  numbers: permitsAll || kinds.some((member) => member === "int" || member === "float" || member === "int8"),
  texts: permitsAll || kinds.includes("text"),
});

// Pick the storage-class conversions once for each result column.
const plan = (name: string, kind: Kind, exact: boolean): Plan => {
  if (kind === "bool") {return truthPlan(name);}
  if (kind === "json") {return { big: (value) => exactInteger(value, name), name, num: undefined, str: jsonValue };}
  const kinds = kind.split("|");
  const refuse = (value: unknown): never => refuseClass(name, kinds, value);
  const permitsAll = kinds.includes("unknown");
  const blob = permitsAll || kinds.includes("bytes") ? undefined : refuse;
  const format = { blob, exact, name, refuse };
  return ownedScalar(kind, format) ?? mixedPlan(kinds, storageClasses(kinds, permitsAll), format);
};

type Row = Record<string, unknown>;

interface RowRead {
  d1: boolean;
  row: Row;
}

const normalizeBlob = ({ d1, row }: RowRead, column: Plan, value: object): void => {
  if (column.blob) {column.blob(value);}
  // LibSQL uses ArrayBuffer. D1 uses a number array.
  if (!(value instanceof Uint8Array) && (value instanceof ArrayBuffer || (d1 && Array.isArray(value)))) {
    row[column.name] = coerce("bytes", value, column.name);
  }
};

const normalizeColumn = (input: RowRead, column: Plan): void => {
  const { row } = input;
  const value = row[column.name];
  if (matchesNull(value) || matchesUndefined(value)) {return;}
  if (matchesBigInt(value)) {
    row[column.name] = column.big(value);
  } else if (matchesNumber(value) && column.num) {
    row[column.name] = column.num(value);
  } else if (matchesString(value) && column.str) {
    row[column.name] = column.str(value);
  } else if (hasObjectType(value)) {
    normalizeBlob(input, column, value);
  }
};

const applyPlans = (row: Row, plans: Readonly<Plan[]>, d1: boolean): void => {
  if (matchesNull(Object.getPrototypeOf(row))) {Object.setPrototypeOf(row, Object.prototype);}
  const input = { d1, row };
  plans.forEach((column) => {normalizeColumn(input, column);});
};

/**
 * Normalizes SQLite values in the driver's rows. Integer results are exact, BLOBs are
 * Uint8Arrays, and JSON and truth values are converted to their generated types.
 * @param {unknown[]} rows - The rows the selected driver's query returned.
 * @param {Columns | undefined} columns - The generated query's columns, when known.
 * @param {{ exact?: boolean, d1?: boolean }} options - Representation already selected by the driver.
 * @returns {unknown[]} The original rows with their column values normalized in place.
 */
export const normalize = function normalize(rows: unknown[], columns: Columns | undefined, { exact = false, d1 = false } = {}): unknown[] {
  if (!Array.isArray(rows)) {return [];}
  if (isEmptyArray(rows)) {return rows;}
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The selected SQLite adapter provides row records after naming any positional columns.
  const records = rows as Row[];
  // oxlint-disable-next-line typescript/no-non-null-assertion -- The driver returns dense rows, and normalization has checked for a non-empty result.
  const outputColumns = columns ? [...columns] : Object.keys(records[FIRST_ROW]!).map((name) => [name, "unknown"] as const);
  const plans = outputColumns.map(([name, kind]) => plan(name, kind, exact));
  // oxlint-disable-next-line rules/no-for-loops -- Preserve the driver array's iterator while updating rows in place.
  for (const row of records) {applyPlans(row, plans, d1);}
  return rows;
};
