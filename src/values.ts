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
  isEmptyArray, isEmptyString, matchesBigInt, matchesBoolean, matchesNull,
  matchesNumber, matchesString, matchesUndefined,
} from "./native-predicates.ts";

import { describe } from "./value-errors.ts";
import { instant, instantOfDate, isoDate as date, timestamp, utcText } from "./value-time.ts";
import { bigInteger, DecodeError, exactInteger, float32s, truth } from "./value-numbers.ts";

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

const identity: Decoder = (x) => x;
const number: Decoder = (x) => +x;

// Interval in IntervalStyle postgres: `1 year 2 mons 3 days 04:05:06.789`. Postgres keeps three
// Parts, each signed on its own: months (written as years and months), days, and a time that may
// Pass 24 hours; a part after a negative one carries `+` (`-1 days +01:00:00`).
const INTERVAL = /^(?:(?<years>[+-]?\d+) years? ?)?(?:(?<months>[+-]?\d+) mons? ?)?(?:(?<days>[+-]?\d+) days? ?)?(?:(?<timeSign>[+-]?)(?<hours>\d+):(?<minutes>\d\d):(?<seconds>\d\d)(?:\.(?<fraction>\d+))?)?$/u;

interface DurationPart {
  magnitude: string;
  negative: boolean;
  unit: string;
}

const ZERO_DURATION = 0;

const calendarPart = (digits: string | undefined, unit: string): DurationPart[] => {
  const magnitude = Number(digits ?? ZERO_DURATION);
  return magnitude === ZERO_DURATION
    ? []
    : [{ magnitude: String(Math.abs(magnitude)), negative: magnitude < ZERO_DURATION, unit }];
};

const clockPart = (magnitude: string, unit: string, negative: boolean): DurationPart[] =>
  magnitude === "0" ? [] : [{ magnitude, negative, unit }];

const intervalClock = (parts: Record<string, string | undefined>): DurationPart[] => {
  const negative = parts.timeSign === "-";
  const fraction = (parts.fraction ?? "").replace(/0+$/u, "");
  const seconds = Number(parts.seconds ?? ZERO_DURATION);
  return [
    ...clockPart(String(Number(parts.hours ?? ZERO_DURATION)), "H", negative),
    ...clockPart(String(Number(parts.minutes ?? ZERO_DURATION)), "M", negative),
    ...clockPart(isEmptyString(fraction) ? String(seconds) : `${seconds}.${fraction}`, "S", negative),
  ];
};

const writeDuration = (parts: DurationPart[], allNegative: boolean): string =>
  parts.map(({ magnitude, negative, unit }) => `${negative && !allNegative ? "-" : ""}${magnitude}${unit}`).join("");

/**
 * An interval's text as an ISO 8601 duration, which `Temporal.Duration.from` reads: `1 year 2 mons
 * 3 days 04:05:06.789` is `P1Y2M3DT4H5M6.789S` and zero is `PT0S`, as Postgres writes them in
 * IntervalStyle iso_8601, and a negative interval has one sign in front, `-1 days` being `-P1D`
 * (Postgres writes `P-1D`, which ISO 8601 and Temporal refuse). An interval whose parts differ in
 * sign has no ISO 8601 form, so it keeps Postgres's, each part signed on its own: `1 mon -1 days`
 * is `P1M-1D`, which Postgres reads back and Temporal refuses. `infinity` and `-infinity` stay
 * those words.
 * @param {string} text - Text emitted by PostgreSQL using its native interval style.
 * @returns {string} The ISO-style duration or the original text if it does not match that style.
 */
export const duration = (text: string): string => {
  const parts = INTERVAL.exec(text)?.groups;
  if (matchesUndefined(parts) || isEmptyString(text)) {return text;}
  const calendar = [
    ...calendarPart(parts.years, "Y"),
    ...calendarPart(parts.months, "M"),
    ...calendarPart(parts.days, "D"),
  ];
  const clock = intervalClock(parts);
  if (isEmptyArray(calendar) && isEmptyArray(clock)) {return "PT0S";}
  const negative = calendar.every((part) => part.negative) && clock.every((part) => part.negative);
  const time = writeDuration(clock, negative);
  return `${negative ? "-" : ""}P${writeDuration(calendar, negative)}${isEmptyString(time) ? "" : `T${time}`}`;
};

/**
 * An interval parameter's text as Postgres reads it, the inverse of `duration` for a negative
 * interval (the round-trip rule): Postgres refuses a sign before the `P` (`-P1DT2H`, as `.run()`
 * returns it and Temporal writes it), and reads each part signed instead (`P-1DT-2H`). Any other
 * text is left as it is.
 * @param {string} text - A signed ISO-style duration used as a query parameter.
 * @returns {string} The duration with a sign on each negative part, or the original text.
 */
export const postgresInterval = (text: string): string => {
  const parts = /^\s*(?<sign>[+-])(?<duration>[Pp][^+-]*)$/u.exec(text)?.groups;
  const durationText = parts?.duration;
  if (matchesUndefined(durationText)) {return text;}
  return parts?.sign === "+"
    ? durationText
    : durationText.replaceAll(/(?<magnitude>\d+(?:[.,]\d+)?)(?<unit>[YMWDHSymwdhs])/gu, "-$<magnitude>$<unit>");
};

interface BufferClass { from(data: string, encoding: string): Uint8Array; isBuffer(v: unknown): boolean }
const NodeBuffer = (globalThis as { Buffer?: BufferClass }).Buffer;
// TextDecoder is a global in every runtime Reylo supports; it is typed here rather than through
// The DOM lib or Node's, which a project that type-checks Reylo's sources need not have.
const Utf8 = (globalThis as unknown as { TextDecoder: new (label?: string) => { decode(bytes: Uint8Array): string } }).TextDecoder;
const utf8Decoder = new Utf8("utf8");

/** UTF-8 bytes as text: a Buffer's own toString where the bytes are one. */
export const utf8 = function utf8(bytes: Uint8Array): string {
  return NodeBuffer?.isBuffer(bytes) ? (bytes as Uint8Array & { toString(encoding: string): string }).toString("utf8") : utf8Decoder.decode(bytes);
};
const {fromHex} = (Uint8Array as unknown as { fromHex?: (hex: string) => Uint8Array });

const BYTE_ESCAPE = "\\";
const BYTE_HEX_PREFIX = "\\x";
const HEX_DIGITS_PER_BYTE = 2;
const HEX_RADIX = 16;
const OCTAL_DIGITS_PER_BYTE = 3;
const OCTAL_RADIX = 8;
const BACKSLASH_BYTE = 0x5C;

/**
 * @param {string} text - The PostgreSQL bytea text in the default hex or escape format.
 * @returns {Uint8Array} The bytes in their original order.
 */
export const bytea = function bytea(text: string): Uint8Array {
  if (text.startsWith(BYTE_HEX_PREFIX)) {
    const hex = text.slice(BYTE_HEX_PREFIX.length);
    if (NodeBuffer) {return NodeBuffer.from(hex, "hex");}
    if (fromHex) {return fromHex(hex);}
    return Uint8Array.from({ length: hex.length / HEX_DIGITS_PER_BYTE }, (_unused, index) => {
      const start = index * HEX_DIGITS_PER_BYTE;
      return Number.parseInt(hex.slice(start, start + HEX_DIGITS_PER_BYTE), HEX_RADIX);
    });
  }
  const bytes: number[] = [];
  let offset = TEXT_START;
  while (offset < text.length) {
    const afterEscape = offset + BYTE_ESCAPE.length;
    if (text[offset] !== BYTE_ESCAPE) {
      // oxlint-disable-next-line unicorn/prefer-code-point -- Bytea's fallback consumes a UTF-16 code unit at a time, including escape text a driver passes through.
      bytes.push(text.charCodeAt(offset));
      offset = afterEscape;
    } else if (text[afterEscape] === BYTE_ESCAPE) {
      bytes.push(BACKSLASH_BYTE);
      offset = afterEscape + BYTE_ESCAPE.length;
    } else {
      offset = afterEscape + OCTAL_DIGITS_PER_BYTE;
      bytes.push(Number.parseInt(text.slice(afterEscape, offset), OCTAL_RADIX));
    }
  }
  return Uint8Array.from(bytes);
};

interface TextCursor {
  offset: number;
  text: string;
}

const CHARACTER_WIDTH = 1;
const HSTORE_SEPARATOR = "=>";
const POSTGRES_NULL = "NULL";
// oxlint-disable-next-line unicorn/no-null -- PostgreSQL NULL inside arrays and hstores has always decoded to JavaScript null.
const SQL_NULL_VALUE = null;

const consumeCharacter = (cursor: TextCursor): string | undefined => {
  const character = cursor.text[cursor.offset];
  cursor.offset += CHARACTER_WIDTH;
  return character;
};

const readQuotedText = (cursor: TextCursor): string => {
  const quoted = { prefix: "", start: cursor.offset + CHARACTER_WIDTH };
  cursor.offset = quoted.start;
  while (cursor.offset < cursor.text.length && cursor.text[cursor.offset] !== '"') {
    if (consumeCharacter(cursor) === "\\") {
      quoted.prefix += cursor.text.slice(quoted.start, cursor.offset - CHARACTER_WIDTH);
      quoted.start = cursor.offset;
      cursor.offset += CHARACTER_WIDTH;
    }
  }
  const suffix = cursor.text.slice(quoted.start, cursor.offset);
  cursor.offset += CHARACTER_WIDTH;
  return quoted.prefix + suffix;
};

const readHstoreValue = (cursor: TextCursor): string | null => {
  cursor.offset += HSTORE_SEPARATOR.length;
  if (cursor.text[cursor.offset] === '"') {return readQuotedText(cursor);}
  cursor.offset += POSTGRES_NULL.length;
  return SQL_NULL_VALUE;
};

/**
 * An hstore's text as an object of its keys: `"a"=>"1", "b c"=>NULL` is `{ a: "1", "b c": null }`.
 * The server quotes every key and value, escapes `"` and `\` with a backslash, writes a null value
 * as a bare NULL and separates the pairs with `, `. A key such as `__proto__` is a key like any other.
 * @param {string} text - The hstore as PostgreSQL writes it.
 * @returns {Record<string, string | null>} The key and value pairs.
 */
export const hstore = (text: string): Record<string, string | null> => {
  const pairs: [string, string | null][] = [];
  const cursor = { offset: TEXT_START, text };
  while (cursor.offset < text.length) {
    while (text[cursor.offset] === " " || text[cursor.offset] === ",") {cursor.offset += CHARACTER_WIDTH;}
    if (text[cursor.offset] !== '"') {break;}
    pairs.push([readQuotedText(cursor), readHstoreValue(cursor)]);
  }
  return Object.fromEntries(pairs);
};

/**
 * An hstore, as `.run()` returns it, in the text its input reads: each key and value quoted, `"`
 * and `\` escaped, a null value a bare NULL. A key whose value is undefined is left out, as JSON
 * leaves it out.
 */
export const hstoreText = function hstoreText(v: object, fail: (message: string) => never): string {
  // Only a plain object's own keys are its pairs: a Map, a Set or a class instance would be written
  // As an empty hstore, so anything else is refused, its constructor named.
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && !matchesNull(proto)) {
    const name = Array.isArray(v) || v instanceof Date || ArrayBuffer.isView(v) ? undefined : (v.constructor as { name?: unknown } | undefined)?.name;
    return fail(`is an hstore, an object of its keys whose values are strings or null; got ${matchesString(name) && name ? `a ${name}` : describe(v)}.`);
  }
  const quote = (s: string): string => `"${s.replaceAll(/[\\"]/gu, String.raw`\$&`)}"`;
  const pairs: string[] = [];
  Iterator.from(Object.entries(v)).forEach(([key, value]) => {
    if (matchesUndefined(value)) {return;}
    if (!matchesNull(value) && !matchesString(value)) {fail(`is an hstore, whose values are strings or null, and its key ${JSON.stringify(key)} holds ${describe(value)}.`);}
    pairs.push(`${quote(key)}=>${matchesNull(value) ? "NULL" : quote(value)}`);
  });
  return pairs.join(", ");
};

const TEXT_DECODERS: Readonly<Record<ScalarKind, Decoder>> = {
  bool: (x) => x === "t",
  int: number,
  float: number,
  int8: (x) => BigInt(x),
  decimal: identity,
  text: identity,
  date,
  timestamp,
  timestamptz: instant,
  interval: duration,
  json: (x) => JSON.parse(x),
  bytes: bytea,
  // Pgvector prints the shortest text of each float, `[1,2.5,1e-07]`, which JSON reads exactly.
  vector: (x) => JSON.parse(x),
  hstore,
  unknown: identity,
};

interface ArrayFormat {
  decode: Decoder;
  delimiter: string;
}

const readArrayValue = (cursor: TextCursor, { decode, delimiter }: ArrayFormat): unknown => {
  const { text } = cursor;
  if (text[cursor.offset] === '"') {return decode(readQuotedText(cursor));}
  const start = cursor.offset;
  while (cursor.offset < text.length && text[cursor.offset] !== delimiter && text[cursor.offset] !== "}") {
    cursor.offset += CHARACTER_WIDTH;
  }
  const value = text.slice(start, cursor.offset);
  return value === POSTGRES_NULL ? SQL_NULL_VALUE : decode(value);
};

const readArray = (cursor: TextCursor, format: ArrayFormat): unknown[] => {
  const items: unknown[] = [];
  cursor.offset += CHARACTER_WIDTH;
  if (cursor.text[cursor.offset] === "}") {
    cursor.offset += CHARACTER_WIDTH;
    return items;
  }
  while (cursor.offset < cursor.text.length) {
    items.push(cursor.text[cursor.offset] === "{" ? readArray(cursor, format) : readArrayValue(cursor, format));
    if (consumeCharacter(cursor) === "}") {return items;}
  }
  return items;
};

/**
 * Postgres's array output: `{a,"b,c",NULL,{d}}`, optionally after its bounds (`[0:1]={...}`).
 * An element is quoted when it holds the delimiter, a brace, a quote, a backslash or white space,
 * or is empty or the word NULL; inside quotes a backslash escapes the next character.
 * @param {string} text - The array as PostgreSQL writes it.
 * @param {Decoder} element - Decodes the text of each non-NULL scalar.
 * @param {string} delimiter - The type's element separator.
 * @returns {unknown[]} The decoded array, including any nested arrays.
 */
export const parseArray = (text: string, element: Decoder, delimiter = ","): unknown[] => {
  const offset = text[TEXT_START] === "[" ? text.indexOf("=") + CHARACTER_WIDTH : TEXT_START;
  return readArray({ offset, text }, { decode: element, delimiter });
};

const ARRAY_KIND_SUFFIX = "[]";

/** The decoder of a Postgres value of `kind` from its text; `delim` is an array's (`;` for `box[]`). */
export const textDecoder = function textDecoder(kind: Kind, delim = ","): Decoder {
  if (kind.endsWith(ARRAY_KIND_SUFFIX)) {
    const element = textDecoder(kind.slice(TEXT_START, -ARRAY_KIND_SUFFIX.length), delim);
    return (x) => parseArray(x, element, delim);
  }
  return TEXT_DECODERS[kind as ScalarKind] ?? identity;
};

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
