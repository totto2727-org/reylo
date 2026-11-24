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
import { civilFromDays, daysFromCivil } from "./gregorian-day.ts";
import type { EngineType } from "./engine-type.ts";
import {
  hasObjectType, isEmptyArray, isEmptyString, matchesBigInt, matchesBoolean, matchesNull,
  matchesNumber, matchesString, matchesUndefined,
} from "./native-predicates.ts";

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
const SQLITE_KINDS: Readonly<Record<string, Kind>> = {
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
 */
export const scalarKind = function scalarKind(name: string, dialect: Dialect): Kind {
  const kinds = [...new Set(name.split("|").flatMap((part) => (dialect === "sqlite" ? (SQLITE_KINDS[part] ?? "unknown") : (dialect === "duckdb" ? (DUCKDB_KINDS[part] ?? "text") : (SQL_KINDS[part] ?? "text"))).split("|")))];
  const wide = kinds.includes("int8") && !kinds.includes("float") ? kinds.filter((k) => k !== "int") : kinds;
  return wide.join("|");
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

const identity: Decoder = (x) => x;
const number: Decoder = (x) => +x;

const FIRST_YEAR_AD = 1;
const ISO_YEAR_ZERO = 0;
const YEAR_DIGITS = 4;
const EXTENDED_YEAR_DIGITS = 6;
const LAST_FOUR_DIGIT_YEAR = 9999;
const CLOCK_DIGITS = 2;
const TEXT_START = 0;
const BC_SUFFIX = " BC";
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = 86_400;
const NO_OFFSET = 0;
const EAST_OFFSET = 1;
const WEST_OFFSET = -1;

const pad = (value: number, width = CLOCK_DIGITS): string => String(value).padStart(width, "0");

/**
 * An ISO 8601 year: four digits from 0000 (1 BC) to 9999, and the extended form, a sign and six
 * digits, outside them (`+010000`, `-000001` for 2 BC), as `Temporal` reads and writes it. A year
 * past 999999, which only a Postgres `date` reaches (up to 5874897), takes the digits it needs after
 * the sign (`+5874897`): ISO 8601 leaves the number of extended digits to the parties that exchange
 * them, Temporal holds no such date in any form, and a sign keeps the rule that every year outside
 * 0000–9999 has one, which `postgresYear` reads back.
 */
const isoYear = (year: number): string => (year >= ISO_YEAR_ZERO && year <= LAST_FOUR_DIGIT_YEAR ? pad(year, YEAR_DIGITS) : `${year < ISO_YEAR_ZERO ? "-" : "+"}${pad(Math.abs(year), EXTENDED_YEAR_DIGITS)}`);

/**
 * A date's or timestamp's text with its year as `isoYear` writes it: Postgres writes a year past
 * 9999 with more digits (`12345-01-01`) and one before 1 AD in its own form (`0002-06-01 BC`), which
 * `Temporal.PlainDate.from` refuses, so `12345-01-01` is `+012345-01-01` and `0002-06-01 BC` is
 * `-000001-06-01`. A four-digit year after 1 BC, `infinity` and `-infinity` are left as they are.
 */
const isoDate = (value: string): string => {
  const dash = value.indexOf("-");
  const beforeChrist = value.endsWith(BC_SUFFIX);
  if (dash < YEAR_DIGITS || (dash === YEAR_DIGITS && !beforeChrist)) {return value;}
  const digits = value.slice(TEXT_START, dash);
  if (!/^\d+$/u.test(digits)) {return value;}
  const year = beforeChrist ? FIRST_YEAR_AD - Number(digits) : Number(digits);
  return isoYear(year) + value.slice(dash, beforeChrist ? -BC_SUFFIX.length : undefined);
};

/** `2026-10-20` as it is; `0002-06-01 BC` → `-000001-06-01` and `12345-01-01` → `+012345-01-01` (`isoDate`). */
const date: Decoder = isoDate;

/** `2026-10-20 10:00:00.123456` → `2026-10-20T10:00:00.123456`, its year as a date's (`isoDate`); `infinity` as written. */
const timestamp: Decoder = (x) => isoDate(x.replace(" ", "T"));

// Timestamptz in DateStyle ISO: `2026-10-20 03:03:00.123456-07`, offsets with seconds before
// Standard time (`-07:52:58`), years past 9999, ` BC`. `new Date(text)`, which postgres.js and
// PGlite use, returns Invalid Date for the last three and reads year 0001 as 2001
// (wiki/driver-decoding/spike/postgres.md); and a Date holds milliseconds, not the server's
// Microseconds. So Reylo moves the wall-clock time to UTC itself, in whole seconds on a day count,
// And keeps the fraction as the server wrote it.
const TSTZ = /^(?<year>\d{4,})-(?<month>\d\d)-(?<day>\d\d) (?<hour>\d\d):(?<minute>\d\d):(?<second>\d\d)(?<fraction>\.\d{1,6})?(?<zoneSign>[+-])(?<zoneHour>\d\d)(?::(?<zoneMinute>\d\d))?(?::(?<zoneSecond>\d\d))?(?<era> BC)?$/u;

/**
 * A date or time parameter's text as Postgres reads it, the inverse of `isoYear` for what `run`
 * returns (the round-trip rule): Postgres 18 refuses an ISO 8601 extended year (`+010000-01-01`,
 * "time zone displacement out of range") and the year 0000 ("date/time field value out of range"),
 * and reads `10000-01-01` and a year before 1 as its own ` BC` form, year 1 − n, so `-000001` is
 * `0002 … BC` and `0000` or `+000000` is `0001 … BC`. Any other text is left as it is.
 */
export const postgresYear = (text: string): string => {
  const parts = /^(?<year>[+-]\d{6,}|0000)(?<rest>-.*)$/u.exec(text)?.groups;
  if (matchesUndefined(parts) || /\sbc$/iu.test(text)) {return text;}
  const year = Number(parts.year);
  return year > ISO_YEAR_ZERO
    ? `${pad(year, YEAR_DIGITS)}${parts.rest}`
    : `${pad(FIRST_YEAR_AD - year, YEAR_DIGITS)}${parts.rest}${BC_SUFFIX}`;
};

/**
 * A timestamptz's text as the instant's ISO 8601 text in UTC: `2026-10-20 10:00:00.123456+02` is
 * `2026-10-20T08:00:00.123456Z`, the fraction as the server wrote it (trailing zeros dropped, none
 * for a whole second), which `Temporal.Instant.from` reads. `infinity` and `-infinity` stay those
 * words.
 */
export const instant = (text: string): string => {
  const parts = TSTZ.exec(text)?.groups;
  if (matchesUndefined(parts)) {return text;}
  const year = matchesUndefined(parts.era) ? Number(parts.year) : FIRST_YEAR_AD - Number(parts.year);
  const zoneSign = parts.zoneSign === "-" ? WEST_OFFSET : EAST_OFFSET;
  const offset = zoneSign * (
    Number(parts.zoneHour) * SECONDS_PER_HOUR
    + Number(parts.zoneMinute ?? NO_OFFSET) * SECONDS_PER_MINUTE
    + Number(parts.zoneSecond ?? NO_OFFSET)
  );
  const day = daysFromCivil(year, Number(parts.month), Number(parts.day));
  const seconds = day * SECONDS_PER_DAY + Number(parts.hour) * SECONDS_PER_HOUR + Number(parts.minute) * SECONDS_PER_MINUTE + Number(parts.second) - offset;
  const utcDay = Math.floor(seconds / SECONDS_PER_DAY);
  const utcTime = seconds - utcDay * SECONDS_PER_DAY;
  const [utcYear, utcMonth, utcDate] = civilFromDays(utcDay);
  const utcHour = Math.floor(utcTime / SECONDS_PER_HOUR);
  const utcMinute = Math.floor(utcTime / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const utcSecond = utcTime % SECONDS_PER_MINUTE;
  return `${isoYear(utcYear)}-${pad(utcMonth)}-${pad(utcDate)}T${pad(utcHour)}:${pad(utcMinute)}:${pad(utcSecond)}${parts.fraction ?? ""}Z`;
};

/**
 * The instant a driver already decoded to a Date (Bun.sql's timestamptz), as the same text: to the
 * millisecond, which is all a Date holds, with its fraction's trailing zeros dropped as the server
 * drops them, so that a value the driver did not cut reads alike on every driver.
 */
export const instantOfDate = function instantOfDate(d: Date, column: string): string {
  validDate(d, column);
  return d.toISOString().replace(/\.?0+Z$/u, "Z");
};

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

type BufferClass = { from(data: string, encoding: string): Uint8Array; isBuffer(v: unknown): boolean };
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

/** Bytea's text: hex (`\x0102ff`, the server's default) or the escape format (`bytea_output = escape`). */
export const bytea = function bytea(x: string): Uint8Array {
  if (x.charCodeAt(0) === 92 && x.charCodeAt(1) === 120) {
    const hex = x.slice(2);
    if (NodeBuffer) {return NodeBuffer.from(hex, "hex");}
    if (fromHex) {return fromHex(hex);}
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);}
    return out;
  }
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== "\\") {out.push(x.charCodeAt(i));}
    else if (x[i + 1] === "\\") {out.push(92), i++;}
    else {out.push(Number.parseInt(x.slice(i + 1, i + 4), 8)), (i += 3);}
  }
  return Uint8Array.from(out);
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
  const quote = (s: string): string => `"${s.replaceAll(/[\\"]/g, String.raw`\$&`)}"`;
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

/** The decoder of a Postgres value of `kind` from its text; `delim` is an array's (`;` for `box[]`). */
export const textDecoder = function textDecoder(kind: Kind, delim = ","): Decoder {
  if (kind.endsWith("[]")) {
    const element = textDecoder(kind.slice(0, -2), delim);
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

/** Why a value cannot be given its kind: Reylo's error, naming the column. */
export class DecodeError extends TypeError {}

/** Why a parameter's value cannot be bound: Reylo's error, naming the parameter. */
export class ParameterError extends TypeError {}

/**
 * A string for a `timestamptz` names its zone: without one the server reads it in the session's
 * TimeZone, which the driver or the server sets.
 */
export const zoned = /(?:\d:\d\d(?::\d\d(?:\.\d+)?)?(?:\s*(?:z|[+-]\d\d?(?::?\d\d){0,2})|\s+[a-z][\w/+-]*)|^-?infinity|^epoch|^now)(?:\s+bc)?$/i;

/** A value as a message about a parameter names it: its kind, or a short form of itself. */
export function describe(v: unknown): string {
  if (matchesNull(v)) {return "null";}
  if (v instanceof Date) {return "a Date";}
  if (Array.isArray(v)) {return "an array";}
  if (v instanceof Uint8Array) {return "binary data";}
  if (matchesBigInt(v)) {return `${v}n`;}
  if (matchesString(v)) {return JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v);}
  if (hasObjectType(v)) {return "an object";}
  return String(v);
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const outOfRange = function outOfRange(value: string, column: string, rounded = false): DecodeError {
  return new DecodeError(
    rounded
      ? `Column "${column}" holds an integer past ±(2^53 - 1), which the driver already rounded to ${value}: a number cannot hold it exactly, so Reylo refuses it rather than return a rounded value. Cast it to text in the statement (cast(${column} as text)) to read it exactly.`
      : `Column "${column}" holds ${value}, an integer past ±(2^53 - 1), which a number cannot hold exactly, so Reylo refuses it rather than return a rounded value. Cast it to text in the statement (cast(${column} as text)) to read it exactly.`,
  );
};

/** An integer as a number, refused where a number cannot hold it exactly. */
export const exactInteger = function exactInteger(v: number | bigint, column: string): number {
  if (matchesBigInt(v)) {
    // Exact: a BigInt past ±(2^53 - 1) converts to a number at least 2^53 in magnitude, since
    // Rounding keeps the order and 2^53 is a number. Comparing BigInts instead took a five-column
    // Row with a SQLite BIGINT, beside which better-sqlite3 reads every integer as a BigInt, from
    // 3.3 to 5.2 ms per 10,000 rows.
    const n = Number(v);
    if (n > MAX_SAFE || n < -MAX_SAFE) {throw outOfRange(String(v), column);}
    return n;
  }
  if (v > MAX_SAFE || v < -MAX_SAFE) {throw outOfRange(String(v), column, true);}
  return v;
};

const INTEGER = /^[+-]?\d+$/u;

/**
 * A 64-bit integer as a BigInt, from the driver's BigInt, its digits, or a number: a number past
 * ±(2^53 - 1) is one the driver already rounded, which no BigInt makes exact again, so it is
 * refused. Anything else (a SQLite REAL a column of INTEGER affinity kept) is left as it is.
 */
export const bigInteger = function bigInteger(v: number | bigint | string, column: string): unknown {
  if (matchesBigInt(v)) {return v;}
  if (matchesString(v)) {return INTEGER.test(v) ? BigInt(v) : v;}
  if (Number.isSafeInteger(v)) {return BigInt(v);}
  if (Number.isInteger(v)) {throw new DecodeError(`Column "${column}" is a 64-bit integer, and the driver already rounded its value to ${v}, past ±(2^53 - 1): Reylo refuses it rather than return a BigInt of a rounded value.`);}
  return v;
};

/**
 * A truth value as a boolean: true, false, 1, 0, `1n`, `0n`, `t`, `f`, `true`, `false`, `1`, `0`,
 * and a BIT(1)'s one byte. MySQL and SQLite have no boolean type and store one as an integer (a
 * TINYINT(1), a BIT(1), a column SQLite declares BOOLEAN), which neither database holds to 0 and 1:
 * any other value is refused, naming the column, rather than read as true.
 */
export const truth = function truth(v: unknown, column: string): boolean {
  switch (typeof v) {
    case "boolean": {
      return v;
    }
    case "number": {
      if (v === 0 || v === 1) {return v === 1;}
      break;
    }
    case "bigint": {
      if (v === BigInt(0) || v === BigInt(1)) {return v === BigInt(1);}
      break;
    }
    case "string": {
      if (v === "t" || v === "true" || v === "1") {return true;}
      if (v === "f" || v === "false" || v === "0") {return false;}
      break;
    }
    case "object": {
      if (v instanceof Uint8Array && v.length === 1 && v[0]! <= 1) {return v[0] === 1;}
      break;
    }
  }
  const shown = v instanceof Uint8Array ? `the bytes 0x${Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("")}` : (matchesString(v) ? JSON.stringify(v) : String(v));
  return refuseTruth(column, shown);
};

/** The error for a value of a boolean column that is not 0 or 1, `shown` as the message names it. */
export function refuseTruth(column: string, shown: string): never {
  throw new DecodeError(
    `Column "${column}" is a boolean, stored as 0 or 1, and holds ${shown}, which is neither: the database does not hold the column to 0 and 1, so Reylo refuses the value rather than guess its truth. Store 0 or 1 in it, or read the stored number with ${column} + 0 in the statement.`,
  );
}

/**
 * A Date a driver handed back must hold a time. Bun.sql 1.4 decodes a date, timestamp or timestamptz
 * before 1 AD as an Invalid Date (its infinities come as the numbers ±Infinity), so an Invalid Date
 * is a value the driver lost, and Reylo refuses it rather than return a wrong one.
 */
function validDate(d: Date, column: string): void {
  if (Number.isNaN(d.getTime())) {throw new DecodeError(`Column "${column}": the driver returned an Invalid Date, which is how Bun.sql decodes a date or timestamp before 1 AD. Reylo refuses it rather than return a wrong value.`);}
}

/**
 * A Date a driver read as UTC (Bun.sql's date and timestamp) back to the text the server's would
 * decode to: `YYYY-MM-DD`, or with `T` and the fraction the driver kept, the year as `isoYear`
 * writes it.
 */
const utcText = function (d: Date, kind: "date" | "timestamp", column: string): string {
  validDate(d, column);
  const date = `${isoYear(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (kind === "date") {return date;}
  const ms = d.getUTCMilliseconds();
  return `${date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ms ? `.${pad(ms, 3).replace(/0+$/u, "")}` : ""}`;
};

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;

/**
 * A MySQL VECTOR's floats from its bytes, 32-bit and little-endian, which mariadb and PlanetScale
 * hand over as they are (mysql2 decodes them itself).
 */
export const float32s = function float32s(bytes: Uint8Array, column: string): number[] {
  if (bytes.byteLength % 4 !== 0) {throw new DecodeError(`Column "${column}" is a VECTOR, whose value is 4 bytes per 32-bit float, and holds ${bytes.byteLength} bytes.`);}
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 4 }, (_unused, index) => view.getFloat32(index * 4, true));
};

/**
 * `v` as a value of `kind`, from the form a driver decoded it to; `column` names it in an error. A
 * number past ±(2^53 - 1) in an integer column is one the driver already rounded, and is refused.
 * `delim` is an array's, where its text is what the driver gave.
 */
export const coerce = function coerce(kind: Kind, v: unknown, column: string, delim = ","): unknown {
  if (matchesNull(v) || matchesUndefined(v)) {return null;}
  if (kind.endsWith("[]")) {
    const element = kind.slice(0, -2);
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
      if (v === Infinity || v === -Infinity) {return v > 0 ? "infinity" : "-infinity";}
      return v;
    }
    case "timestamptz": {
      if (matchesString(v)) {return instant(v);}
      if (v instanceof Date) {return instantOfDate(v, column);}
      // Bun.sql's `infinity`.
      if (v === Infinity || v === -Infinity) {return v > 0 ? "infinity" : "-infinity";}
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
      if (matchesBoolean(v)) {return Uint8Array.of(v ? 1 : 0);}
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
