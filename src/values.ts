// How Reylo represents a SQL value in JavaScript: one table, which the type renderer
// (src/render.ts), the JSON Schema writer (src/schema.ts) and the run time's decoders
// (src/decode.ts, src/decode-mysql.ts, src/decode-sqlite.ts) all read, so that the type a module
// Declares and the value `run` returns cannot drift apart. Reylo sets
// Every value's type itself, on every driver, whatever the app configured its driver to return:
// One representation per SQL type.
//
// A value's representation is its kind, which the build writes into the module for each output
// Column (`columns`, as `[name, kind]`): `bool` is a boolean; `int` and `float` a number; `int8` a
// BigInt; `decimal` the exact decimal text; `date` the text `YYYY-MM-DD`; `timestamp` the server's
// Wall-clock text with `T` between the date and the time (a year of either outside 0000–9999 in
// ISO 8601's extended form, `+012345` or `-000001` for 2 BC); `timestamptz` the instant's ISO 8601 text
// In UTC, with `Z` and the server's fraction; `interval` an ISO 8601 duration with its sign in
// Front; `json` the parsed value; `bytes` a Uint8Array (a Buffer is one); `vector` pgvector's
// `vector` or `halfvec` as an array of its numbers; `hstore` an hstore's keys as an object, each
// Value a string or null; `text` the server's text, which every other type is (time, uuid, an
// Enum's label, a range, a row value); `unknown` whatever the driver gives (a SQLite column with no
// Declared type). A DuckDB STRUCT, MAP or UNION is decoded by the result's own types
// (src/decode-duckdb.ts), each of its values in its own kind's form. `k[]` is an array of `k`, a NULL element `null`, and `a|b` either (a MySQL
// Expression whose type the bound value decides). No kind is a JavaScript Date. An array's text
// Separates its elements with a comma, or with its element type's own delimiter (`:` for PostGIS's
// `geometry`), which a column carries beside its kind.
//
// This module runs in every generated module's process, so it names no Node type: a Buffer is
// Reached through `globalThis` where one exists.
import type { EngineType } from "./engine-type.ts";
import {
  matchesBigInt, matchesBoolean, matchesNull,
  matchesNumber, matchesString, matchesUndefined,
} from "./native-predicates.ts";

import { bytea } from "./value-bytes.ts";
import { instant, instantOfDate, utcText } from "./value-time.ts";
import { bigInteger, exactInteger, float32s, truth } from "./value-numbers.ts";
import { duration, hstore, parseArray } from "./value-text.ts";

export { bytea, utf8 } from "./value-bytes.ts";
export { describe, ParameterError } from "./value-errors.ts";
export { instant, instantOfDate, postgresYear, zoned } from "./value-time.ts";
export { bigInteger, DecodeError, exactInteger, float32s, refuseTruth, truth } from "./value-numbers.ts";

export type Dialect = "postgres" | "mysql" | "sqlite" | "duckdb";

/** A scalar value's representation. */
export type ScalarKind = "bool" | "int" | "float" | "int8" | "decimal" | "text" | "date" | "timestamp" | "timestamptz" | "interval" | "json" | "bytes" | "vector" | "hstore" | "unknown";
/** A column's kind as a module carries it: a scalar kind, `k[]` for an array of `k`, `a|b` for either. */
export type Kind = string;
/** The output columns a module carries, in the statement's order; an array's `delimiter` where it is not a comma. */
export type Columns = Readonly<(Readonly<[name: string, kind: Kind, delimiter?: string]>)[]>;

/** The TypeScript type of each scalar kind: what a value of that kind is at run time. */
export const TS_TYPE: Readonly<Record<ScalarKind, string>> = {
  bool: "boolean",
  int: "number",
  float: "number",
  int8: "bigint",
  decimal: "string",
  text: "string",
  date: "string",
  timestamp: "string",
  timestamptz: "string",
  interval: "string",
  // Any JSON value, the type `reylo` exports (src/render.ts).
  json: "Json",
  bytes: "Uint8Array",
  vector: "number[]",
  hstore: "Record<string, string | null>",
  unknown: "unknown",
};

/**
 * The kind of a Postgres or MySQL base type, by the engine's name for it (MySQL's are the Postgres
 * names: a DATETIME is `timestamp`, a BIT `bytea`, a YEAR `int2`). Every type not named here is
 * its text: Reylo owns every oid, so the driver never parses one (an enum's label, a range, `time`,
 * `uuid`, `money`, `point`, `xml`, a row value). pgvector's `vector` and `halfvec`, and an
 * `hstore`, are extensions' types, named by their names as every created type is.
 */
const SQL_KINDS: Readonly<Record<string, ScalarKind>> = {
  bool: "bool",
  int2: "int",
  int4: "int",
  oid: "int",
  float4: "float",
  float8: "float",
  int8: "int8",
  numeric: "decimal",
  date: "date",
  timestamp: "timestamp",
  timestamptz: "timestamptz",
  interval: "interval",
  json: "json",
  jsonb: "json",
  bytea: "bytes",
  vector: "vector",
  halfvec: "vector",
  hstore: "hstore",
};

/**
 * SQLite's: the engine names a column by its affinity, and a column declared BIGINT, INT8 or
 * UNSIGNED BIG INT `int8`, since the declared width decides on every database.
 * An INTEGER is a number, exact or an error; an `int8` a BigInt on every SQLite
 * driver (src/decode-sqlite.ts reads either); a NUMERIC holds whichever storage class the row
 * stored; `bool` is a truth value or a column declared BOOLEAN; a column with no declared type,
 * or ANY in a STRICT table, is whatever the driver gives.
 */
const SQLITE_KINDS: Readonly<Record<string, ScalarKind | "int|float|text">> = {
  integer: "int",
  int8: "int8",
  real: "float",
  text: "text",
  blob: "bytes",
  numeric: "int|float|text",
  bool: "bool",
};

/**
 * DuckDB's, by its own lowercased name: its narrow integers are numbers, its 64-bit and wider ones
 * (BIGINT, UBIGINT, HUGEINT, UHUGEINT, BIGNUM) BigInts, a DECIMAL its exact text, every TIMESTAMP
 * but TIMESTAMPTZ a wall-clock text, and a UUID, a TIME, a BIT and anything not named here its
 * text.
 */
const DUCKDB_KINDS: Readonly<Record<string, ScalarKind>> = {
  boolean: "bool",
  tinyint: "int",
  smallint: "int",
  integer: "int",
  utinyint: "int",
  usmallint: "int",
  uinteger: "int",
  bigint: "int8",
  ubigint: "int8",
  hugeint: "int8",
  uhugeint: "int8",
  bignum: "int8",
  float: "float",
  double: "float",
  decimal: "decimal",
  blob: "bytes",
  date: "date",
  timestamp: "timestamp",
  timestamp_s: "timestamp",
  timestamp_ms: "timestamp",
  timestamp_ns: "timestamp",
  timestamptz: "timestamptz",
  timestamptz_ns: "timestamptz",
  interval: "interval",
};

/**
 * The kind of a base type by its engine name, `a|b` naming either. An integer that may be a BIGINT
 * or a narrower integer (a MySQL expression a temporary table may widen, `int8|int4`) is a BIGINT's,
 * a BigInt either way, where no float shares the column: there a number may be either.
 * @param {string} name - The engine's type name or union of type names.
 * @param {Dialect} dialect - The database dialect.
 * @returns {[ScalarKind, ...ScalarKind[]]} The scalar representations in their existing order.
 */
export const scalarKindParts = function scalarKindParts(name: string, dialect: Dialect): [ScalarKind, ...ScalarKind[]] {
  const kinds = [...new Set(name.split("|").flatMap((part) => (dialect === "sqlite" ? (SQLITE_KINDS[part] ?? "unknown") : (dialect === "duckdb" ? (DUCKDB_KINDS[part] ?? "text") : (SQL_KINDS[part] ?? "text"))).split("|")))];
  const parts = kinds.includes("int8") && !kinds.includes("float") ? kinds.filter((kind) => kind !== "int") : kinds;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The typed catalog tables supply one or more ScalarKind names, and widening always keeps int8.
  return parts as [ScalarKind, ...ScalarKind[]];
};

export const scalarKind = function scalarKind(name: string, dialect: Dialect): Kind {
  return scalarKindParts(name, dialect).join("|");
};

/** The delimiter of an array's text, where the element type's is not a comma: a column carries it beside its kind. */
export const arrayDelimiter = function arrayDelimiter(t: EngineType): string | undefined {
  return t.kind === "array" ? t.delimiter : undefined;
};

/** The kind of a value of the engine's type `t`, standing in a result row (not inside a JSON document). */
export const columnKind = function columnKind(t: EngineType, dialect: Dialect): Kind {
  switch (t.kind) {
    case "scalar": {
      return scalarKind(t.name, dialect);
    }
    case "enum": {
      return "text";
    }
    case "array": {
      // A row value's array is the text Postgres prints, as a row value is.
      if ((t.of.kind === "scalar" && t.of.name === "record") || t.of.kind === "composite") {return "text";}
      return `${columnKind(t.of, dialect)}[]`;
    }
    case "object":
    case "list":
    case "json":
    case "rows": {
      return "json";
    }
    case "composite": {
      return "text";
    }
    // Decoded by the result's own types (src/decode-duckdb.ts).
    case "struct":
    case "map":
    case "union":
    case "tuple":
    case "unknown": {
      return "unknown";
    }
  }
};

/** The TypeScript type of a scalar kind, `a|b` as the union of both; `unknown` where any part is. */
export const kindType = function kindType(kind: Kind): string {
  const parts = kind.split("|").map((currentPart) => TS_TYPE[currentPart as ScalarKind] ?? "unknown");
  return parts.includes("unknown") ? "unknown" : [...new Set(parts)].join(" | ");
};

// ---------------------------------------------------------------------------------------------
// The value of each kind from the server's text, as every Postgres driver but Bun.sql hands it
// Over (pg, pg-promise, Neon, PGlite, and postgres.js through `.raw()`), at the server's default
// DateStyle (ISO), IntervalStyle and bytea_output, which the drivers' own parsers read too.

export type Decoder = (text: string) => unknown;

const TEXT_START = 0;

export { duration, hstore, hstoreText, parseArray, postgresInterval, textDecoder } from "./value-text.ts";

const ARRAY_KIND_SUFFIX = "[]";

// ---------------------------------------------------------------------------------------------
// The value of each kind from whatever a driver decoded it to: for the drivers that take no
// Decoder (Bun.sql; the SQLite drivers, whose JSON is text and whose truth values are integers),
// And for the rare value a driver decoded before Reylo could name its type. Each converts the
// Forms a driver is measured to give (wiki/driver-decoding/spike/) and leaves a value already in
// Reylo's form as it is.

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;
/**
 * `v` as a value of `kind`, from the form a driver decoded it to; `column` names it in an error. A
 * number past ±(2^53 - 1) in an integer column is one the driver already rounded, and is refused.
 * `delim` is an array's, where its text is what the driver gave.
 */
export const coerce = function coerce(kind: Kind, v: unknown, column: string, delim = ","): unknown {
  if (matchesNull(v) || matchesUndefined(v)) {return null;}
  if (kind.endsWith(ARRAY_KIND_SUFFIX)) {
    const element = kind.slice(TEXT_START, -ARRAY_KIND_SUFFIX.length);
    if (matchesString(v)) {return parseArray(v, (s) => coerce(element, s, column), delim);}
    if (Array.isArray(v)) {return v.map((e) => (Array.isArray(e) ? coerce(kind, e, column, delim) : coerce(element, e, column)));}
    // A MySQL VECTOR's bytes: no driver gives any other array of floats as bytes.
    if (element === "float" && isBytes(v)) {return float32s(v, column);}
    // Bun.sql's int4[] and float4[] are typed arrays.
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {return Array.from(v as unknown as ArrayLike<unknown>, (e) => coerce(element, e, column));}
    return v;
  }
  if (kind.includes("|")) {return coerceEither(kind, v, column);}
  switch (kind as ScalarKind) {
    case "bool": {
      return truth(v, column);
    }
    case "int":
    case "float": {
      if (matchesNumber(v)) {return kind === "int" ? exactInteger(v, column) : v;}
      if (matchesBigInt(v)) {return exactInteger(v, column);}
      if (matchesString(v) && v !== "" && !Number.isNaN(+v)) {return kind === "int" && /^[+-]?\d+$/u.test(v) ? exactInteger(BigInt(v), column) : +v;}
      return v;
    }
    case "int8": {
      if (matchesBigInt(v) || matchesNumber(v) || matchesString(v)) {return bigInteger(v, column);}
      return v;
    }
    case "decimal": {
      if (matchesBigInt(v) || matchesNumber(v)) {return String(v);}
      return v;
    }
    case "date":
    case "timestamp": {
      if (v instanceof Date) {return utcText(v, kind as "date" | "timestamp", column);}
      // Bun.sql's `infinity`.
      if (v === Infinity || v === -Infinity) {return v === Infinity ? "infinity" : "-infinity";}
      return v;
    }
    case "timestamptz": {
      if (matchesString(v)) {return instant(v);}
      if (v instanceof Date) {return instantOfDate(v, column);}
      // Bun.sql's `infinity`.
      if (v === Infinity || v === -Infinity) {return v === Infinity ? "infinity" : "-infinity";}
      return v;
    }
    case "interval": {
      return matchesString(v) ? duration(v) : v;
    }
    case "json":
    case "vector": {
      return matchesString(v) ? JSON.parse(v) : v;
    }
    case "hstore": {
      return matchesString(v) ? hstore(v) : v;
    }
    case "bytes": {
      if (isBytes(v)) {return v;}
      if (v instanceof ArrayBuffer) {return new Uint8Array(v);}
      // D1's BLOB is an array of numbers; mariadb's and Bun.sql's BIT(1) a truth value.
      if (Array.isArray(v)) {return Uint8Array.from(v as number[]);}
      if (matchesBoolean(v)) {return Uint8Array.of(Number(v));}
      if (matchesString(v)) {return bytea(v);}
      return v;
    }
    case "text": {
      if (matchesString(v)) {return v;}
      // Mariadb's SET is an array of its members.
      if (Array.isArray(v)) {return v.join(",");}
      if (matchesNumber(v) || matchesBigInt(v)) {return String(v);}
      return v;
    }
    default: {
      return v;
    }
  }
};

/**
 * A value of `a|b`: by what the driver gave, since only the value says which it is. A string is a
 * DECIMAL's or a text's, never a BIGINT's: each MySQL driver's BIGINT reaches here as a BigInt
 * already (src/decode-mysql.ts reads it by the result's own column type, and mariadb gives one).
 */
function coerceEither(kind: Kind, v: unknown, column: string): unknown {
  const kinds = kind.split("|");
  // A MySQL BIGINT is a BigInt; a SQLite INTEGER a number, exact or refused.
  if (matchesBigInt(v)) {return kinds.includes("int8") ? v : exactInteger(v, column);}
  if (matchesNumber(v)) {
    // Where the column may hold a float, a number past 2^53 may be one.
    if (kinds.includes("float") || !Number.isInteger(v)) {return v;}
    if (kinds.includes("int")) {return exactInteger(v, column);}
    return kinds.includes("int8") ? bigInteger(v, column) : v;
  }
  if (v instanceof Date) {return kinds.includes("timestamp") ? utcText(v, "timestamp", column) : kinds.includes("date") ? utcText(v, "date", column) : kinds.includes("timestamptz") ? instantOfDate(v, column) : v;}
  if (v instanceof ArrayBuffer || (Array.isArray(v) && kinds.includes("bytes"))) {return coerce("bytes", v, column);}
  return v;
}
