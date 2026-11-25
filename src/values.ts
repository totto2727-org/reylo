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

export { coerce } from "./value-coerce.ts";
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
// oxlint-disable-next-line eslint/sort-keys -- Preserve the representation table's public enumeration order.
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
// oxlint-disable-next-line eslint/sort-keys -- Keep server types grouped by their representation.
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
// oxlint-disable-next-line eslint/sort-keys -- Keep SQLite affinities in their documented representation order.
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
// oxlint-disable-next-line eslint/sort-keys -- Keep DuckDB integer width and timestamp precision families adjacent.
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

const dialectKind = (name: string, dialect: Dialect): string => {
  if (dialect === "sqlite") {return SQLITE_KINDS[name] ?? "unknown";}
  if (dialect === "duckdb") {return DUCKDB_KINDS[name] ?? "text";}
  return SQL_KINDS[name] ?? "text";
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
  const kinds = [...new Set(name.split("|").flatMap((part) => dialectKind(part, dialect).split("|")))];
  const parts = kinds.includes("int8") && !kinds.includes("float") ? kinds.filter((kind) => kind !== "int") : kinds;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The typed catalog tables supply one or more ScalarKind names, and widening always keeps int8.
  return parts as [ScalarKind, ...ScalarKind[]];
};

export const scalarKind = function scalarKind(name: string, dialect: Dialect): Kind {
  return scalarKindParts(name, dialect).join("|");
};

/**
 * Finds an array element delimiter carried alongside the column kind.
 * @param {EngineType} type - The type reported by the database engine.
 * @returns {string | undefined} The delimiter when the engine supplies one.
 */
export const arrayDelimiter = function arrayDelimiter(type: EngineType): string | undefined {
  return type.kind === "array" ? type.delimiter : undefined;
};

/**
 * Finds the representation for a value standing in a result row.
 * @param {EngineType} type - The type reported by the database engine.
 * @param {Dialect} dialect - The database dialect.
 * @returns {Kind} The kind carried by the generated column.
 */
// oxlint-disable-next-line typescript/consistent-return -- The typed switch covers the full engine union and preserves the original fall-through for malformed runtime input.
export const columnKind = function columnKind(type: EngineType, dialect: Dialect): Kind {
  // oxlint-disable-next-line eslint/default-case -- Keep each EngineType discriminant explicit so additions to the engine union require a representation.
  switch (type.kind) {
    case "scalar": {
      return scalarKind(type.name, dialect);
    }
    case "enum": {
      return "text";
    }
    case "array": {
      // A row value's array is the text Postgres prints, as a row value is.
      if ((type.of.kind === "scalar" && type.of.name === "record") || type.of.kind === "composite") {return "text";}
      return `${columnKind(type.of, dialect)}[]`;
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

const typesByName: Readonly<Partial<Record<string, string>>> = TS_TYPE;

/**
 * Finds the generated TypeScript type for a scalar kind or union of kinds.
 * @param {Kind} kind - The scalar name or pipe-delimited union.
 * @returns {string} The TypeScript type, or unknown if any part is unknown.
 */
export const kindType = function kindType(kind: Kind): string {
  const parts = kind.split("|").map((currentPart) => typesByName[currentPart] ?? "unknown");
  return parts.includes("unknown") ? "unknown" : [...new Set(parts)].join(" | ");
};

// ---------------------------------------------------------------------------------------------
// The value of each kind from the server's text, as every Postgres driver but Bun.sql hands it
// Over (pg, pg-promise, Neon, PGlite, and postgres.js through `.raw()`), at the server's default
// DateStyle (ISO), IntervalStyle and bytea_output, which the drivers' own parsers read too.

export type Decoder = (text: string) => unknown;

export { duration, hstore, hstoreText, parseArray, postgresInterval, textDecoder } from "./value-text.ts";
