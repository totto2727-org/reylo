import { encodeDuckdb } from "./decode-duckdb.ts";
import type { EngineType } from "./engine-type.ts";
import type { Dialect, QueryModule } from "./execute-types.ts";
import { hasObjectType, matchesBigInt, matchesBoolean, matchesNull, matchesNullish, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";
import { describe, hstoreText, ParameterError, postgresInterval, postgresYear, zoned } from "./values.ts";

export type { EngineType } from "./engine-type.ts";

// oxlint-disable-next-line unicorn/no-null -- Native database bindings and JSON serialization use the JavaScript null value.
export const NATIVE_NULL = null;

// The parameters are an object, refused before anything reaches the database otherwise: an
// Array, which `run` took in the order of `params` from 2026-10-03, was dropped on 2026-10-20
// (wiki/design.md §9), so the call says which key each value binds.
// oxlint-disable-next-line rules/no-type-predicate -- The synchronous parameter validator narrows its callers without loading the optional Effect runtime.
export const checkParams: (query: QueryModule, input: unknown) => asserts input is Record<string, unknown> = function checkParams(query, input) {
  if (!matchesNull(input) && hasObjectType(input) && !Array.isArray(input)) {return;}
  const keys = query.params.map((name) => `${/^(?:[A-Za-z_$][\w$]*|\d+)$/u.test(name) ? name : JSON.stringify(name)}: ...`);
  const takes = keys.length ? `This statement takes { ${keys.join(", ")} }.` : "This statement takes none: leave them out.";
  throw new ParameterError(`The parameters must be an object keyed by parameter name, or by number for positional placeholders ({ 1: ..., 2: ... }); got ${Array.isArray(input) ? "an array" : String(input)}. ${takes}`);
};

const FIRST_ARRAY_INDEX = 0;
const ARRAY_INDEX_STEP = 1;

export const indexedElements = function* (array: Readonly<unknown[]>): Generator<[number, unknown]> {
  const cursor = { index: FIRST_ARRAY_INDEX };
  // Read the live length and each indexed value, including holes and inherited properties.
  while (cursor.index < array.length) {
    yield [cursor.index, array[cursor.index]];
    cursor.index += ARRAY_INDEX_STEP;
  }
};

export const isJson = (kind: EngineType["kind"] | undefined): boolean => kind === "json" || kind === "object" || kind === "list" || kind === "rows";

// A JSON parameter's value is a JavaScript value, which reaches the database as its JSON text
// (JSON.stringify), so a string is a JSON string on every driver; null is SQL NULL where the
// Statement takes SQL NULL for the parameter, and JSON's null elsewhere (`JSON_NULL`). Each driver
// Left to itself did something else (wiki/driver-decoding.md, 2026-10-12): pg wrote an array as
// An array literal and a string as raw JSON text, mariadb expanded an array into a list, the
// SQLite drivers refused an object, and mysql2 bound 5 as 5.0.
export const isJsonValue = function isJsonValue(query: QueryModule, name: string, parameterValue: unknown): boolean {
  return !matchesNullish(parameterValue) && isJson(query.inputs?.[name]?.type.kind);
};

/**
 * JSON's null, which a JSON parameter's null stands for where the statement takes no SQL NULL for
 * it, as the engine reports it: a NOT NULL `jsonb` column holds JSON's null and refuses SQL NULL.
 * A `coalesce` or a null test of the parameter takes no SQL NULL either, as for every other type,
 * so `coalesce(:p::jsonb, col)` given null keeps JSON's null rather than `col`; a cast to
 * `nullable(jsonb)` is what passes SQL NULL there. It stays apart from SQL NULL until each driver's
 * binding writes it as the JSON text `null`.
 */
export const JSON_NULL: unique symbol = Symbol("JSON null");

/**
 * A JSON parameter's value as JSON: `JSON_NULL` as null.
 *
 * @param {unknown} candidate - The JavaScript value or internal marker for JSON null.
 * @returns {unknown} The JavaScript value used for JSON serialization.
 */
export const jsonValue = (candidate: unknown): unknown => candidate === JSON_NULL ? NATIVE_NULL : candidate;

/**
 * A JSON parameter's value as the JSON text a driver binds.
 *
 * @param {unknown} candidate - The parameter before serialization.
 * @returns {string} The JSON text sent to a driver that accepts encoded JSON.
 */
export const jsonText = (candidate: unknown): string => JSON.stringify(jsonValue(candidate));

// A date or time value's type says whether it has a zone (src/render.ts),
// And a value that would be read in a zone nobody chose is refused before the
// Statement runs. A `timestamp` or a `date` (MySQL's DATETIME and TIMESTAMP are the engine's
// `timestamp`) takes no Date: pg and mysql2 wrote its wall-clock time in the app's zone,
// Postgres.js in the server's, PGlite and Bun.sql in UTC, and Bun.sql's `date` failed in every
// Zone. A `timestamptz` takes a string that names its zone, which is what `run` returns for one:
// Without a zone the server reads the text in the session's TimeZone, which the driver or the
// Server sets, and a Date is refused too, as every other type's value is but a string,
// With the call that writes it as one.

export const isTime = (type: EngineType | undefined): boolean => type?.kind === "scalar" && type.name.split("|").every((part) => part === "timestamp" || part === "timestamptz" || part === "date");

const checkZonedTime = (name: string, parameterValue: unknown): void => {
  if (parameterValue instanceof Date) {
    throw new ParameterError(`Parameter "${name}" is a timestamptz, which takes the instant as a string that names its zone, as \`.run()\` returns one, not a Date: pass date.toISOString() ("2026-10-12T19:06:48.282Z").`);
  }
  if (matchesString(parameterValue) && !zoned.test(parameterValue.trim())) {
    throw new ParameterError(`Parameter "${name}" is a timestamptz, an instant, so a string for it names its zone ("2026-10-12T19:06:48.282Z", "2026-10-12 19:06:48+09", "2026-10-12 19:06:48 America/Los_Angeles"); got ${JSON.stringify(parameterValue)}, which the server would read in the session's time zone.`);
  }
};

const checkScalarTime = (type: Extract<EngineType, { kind: "scalar" }>, name: string, parameterValue: unknown): void => {
  if (type.name === "timestamptz") {
    checkZonedTime(name, parameterValue);
    return;
  }
  if (parameterValue instanceof Date && type.name.split("|").every((part) => part === "timestamp" || part === "date")) {
    throw new ParameterError(`Parameter "${name}" is a ${type.name === "date" ? "date" : "timestamp"} without a time zone, so it takes the wall-clock text ("2026-10-12 19:06:48.282", "2026-10-12"), not a Date: drivers write a Date's time in different zones (the app's, the server's or UTC).`);
  }
};

export const checkTime = function checkTime(type: EngineType | undefined, name: string, parameterValue: unknown): void {
  if (matchesUndefined(type) || matchesNullish(parameterValue)) {return;}
  if (type.kind === "array") {
    if (Array.isArray(parameterValue)) {Iterator.from(parameterValue).forEach((element) => {checkTime(Array.isArray(element) ? type : type.of, name, element);});}
  } else if (type.kind === "scalar") {
    checkScalarTime(type, name, parameterValue);
  }
};

// A binary parameter takes a Uint8Array (a Buffer is one), as `.run()` returns binary data and
// As a structured parameter's binary member does (src/rows.ts). Anything else would reach the
// Driver as it is, and a string means something different on each database: Postgres reads it
// As bytea's hex or escape text, MySQL stores the bytes of its UTF-8, and SQLite stores it as
// TEXT, which comes back a string. So base64 text was stored as its own letters.
export const checkBinary = function checkBinary(type: EngineType | undefined, name: string, parameterValue: unknown): void {
  if (matchesUndefined(type) || matchesNullish(parameterValue)) {return;}
  if (type.kind === "array") {
    if (Array.isArray(parameterValue)) {Iterator.from(parameterValue).forEach((element) => {checkBinary(Array.isArray(element) ? type : type.of, name, element);});}
    return;
  }
  if (type.kind !== "scalar" || (type.name !== "bytea" && type.name !== "blob") || parameterValue instanceof Uint8Array) {return;}
  throw new ParameterError(`Parameter "${name}" is binary data, so it takes a Uint8Array (a Buffer is one), as \`.run()\` returns one; got ${describe(parameterValue)}. ${parameterValue instanceof ArrayBuffer ? "Wrap an ArrayBuffer in one: new Uint8Array(buffer)." : "Decode base64 or hex text into one first."}`);
};

/** The engine's scalar information for a dense pgvector value.
 *
 * @param {EngineType} type - The engine type to inspect.
 * @returns {Extract<EngineType, { kind: "scalar" }> | undefined} The vector type if recognized.
 */
const vectorType = (type: EngineType): Extract<EngineType, { kind: "scalar" }> | undefined =>
  type.kind === "scalar" && (type.name === "vector" || type.name === "halfvec") ? type : undefined;

const vectorEntryText = (parameterValue: unknown): string => {
  if (matchesString(parameterValue)) {return JSON.stringify(parameterValue);}
  return matchesNumber(parameterValue) ? String(parameterValue) : typeof parameterValue;
};

/**
 * A vector's floats as the text a VECTOR's `to_vector` and pgvector's input read; JSON's, which would write NaN and ±Infinity as null, so those are refused.
 *
 * @param {Readonly<unknown[]>} vector - The input array, which must contain finite numbers.
 * @param {string} name - The parameter name used in diagnostics.
 * @param {string} what - The engine's description of the supported vector.
 * @returns {string} The vector literal read by the database.
 */
const vectorText = function vectorText(vector: Readonly<unknown[]>, name: string, what: string): string {
  vector.forEach((element, index) => {
    if (!matchesNumber(element) || !Number.isFinite(element)) {
      throw new ParameterError(`Parameter "${name}" is ${what}, an array of finite numbers, and the element at [${index}] is ${vectorEntryText(element)}.`);
    }
  });
  return JSON.stringify(vector);
};

const SQLITE_FALSE_INTEGER = 0;
const SQLITE_TRUE_INTEGER = 1;

// What `run` returns goes back in as the database reads it (the round-trip rule, src/render.ts):
// On Postgres a date or time with an extended or BC year in Postgres's own form, which refuses
// `+010000` and `0000`, and a negative interval with each part signed (`-P1D` as `P-1D`), since
// Postgres refuses a sign before the `P`; on SQLite a truth value, which a BOOLEAN column returns, as 1 or 0, since
// Better-sqlite3 refuses a boolean ("SQLite3 can only bind numbers, strings, bigints, buffers, and
// Null") and libSQL binds `true` as the REAL 1.0. A query without `inputs` gets neither. On MySQL
// A VECTOR, MySQL's one array, as the text of its floats, `[1,2.5]`, which the engine's
// `to_vector(?)` reads: drivers left to themselves sent an array as the text "1,2,3" (mysql2's
// Execute()) or expanded it into a list of values (mysql2's query(), mariadb). On Postgres a
// Pgvector vector the same way, as the text its input reads, and an array of vectors as an array
// Of those texts.
const sqliteBoolean = (parameterValue: unknown): unknown => {
  if (matchesBoolean(parameterValue)) {return parameterValue ? SQLITE_TRUE_INTEGER : SQLITE_FALSE_INTEGER;}
  return parameterValue;
};

const pgvectorText = (type: Extract<EngineType, { kind: "scalar" }>, name: string, values: Readonly<unknown[]>): string => {
  if (!values.length) {throw new ParameterError(`Parameter "${name}" is a pgvector ${type.name}, which has one dimension at least; got an empty array.`);}
  return vectorText(values, name, `a pgvector ${type.name}`);
};

const postgresEncodedText = (type: EngineType, parameterValue: string): string => {
  if (isTime(type)) {return postgresYear(parameterValue);}
  return type.kind === "scalar" && type.name === "interval" ? postgresInterval(parameterValue) : parameterValue;
};

const postgresScalar = (type: EngineType, parameterValue: unknown, name: string): unknown => {
  const vector = vectorType(type);
  if (vector && Array.isArray(parameterValue)) {return pgvectorText(vector, name, parameterValue);}
  if (type.kind === "scalar" && type.name === "hstore" && !matchesNull(parameterValue) && hasObjectType(parameterValue)) {
    return hstoreText(parameterValue, (message) => {throw new ParameterError(`Parameter "${name}" ${message}`);});
  }
  return matchesString(parameterValue) ? postgresEncodedText(type, parameterValue) : parameterValue;
};

const encodePostgres = (type: EngineType | undefined, parameterValue: unknown, name: string): unknown => {
  if (matchesUndefined(type) || matchesNullish(parameterValue)) {return parameterValue;}
  if (type.kind === "array") {
    return Array.isArray(parameterValue)
      ? parameterValue.map((element) => encodePostgres(Array.isArray(element) && matchesUndefined(vectorType(type.of)) ? type : type.of, element, name))
      : parameterValue;
  }
  return postgresScalar(type, parameterValue, name);
};

export const encode = ({ dialect, name }: { dialect: Dialect; name: string }, type: EngineType | undefined, parameterValue: unknown): unknown => {
  if (matchesUndefined(type) || matchesNullish(parameterValue)) {return parameterValue;}
  if (dialect === "duckdb") {return encodeDuckdb(type, parameterValue, name);}
  if (dialect === "sqlite") {return sqliteBoolean(parameterValue);}
  if (dialect === "mysql") {return type.kind === "array" && Array.isArray(parameterValue) ? vectorText(parameterValue, name, "a VECTOR") : parameterValue;}
  return encodePostgres(type, parameterValue, name);
};

// Sqlite3 6.0.1 binds a BigInt as NULL, with no error (`select cast(? as text)` with
// 9007199254740993n gave null), and a Durable Object's exec() refuses one, where every other
// SQLite driver binds it exactly. A BigInt a number holds exactly goes as that number. A larger
// One goes as its digits to a parameter of a BIGINT column (the engine's int8), whose INTEGER
// Affinity reads the text as that integer in an insert and a comparison alike, and is refused
// Anywhere else, where the text would stay text.
export const numberOrDigits = function numberOrDigits(parameterValue: unknown, type: EngineType | undefined, driver: "sqlite3" | "durable-object"): unknown {
  if (!matchesBigInt(parameterValue)) {return parameterValue;}
  if (parameterValue >= BigInt(Number.MIN_SAFE_INTEGER) && parameterValue <= BigInt(Number.MAX_SAFE_INTEGER)) {return Number(parameterValue);}
  if (type?.kind === "scalar" && type.name === "int8") {return String(parameterValue);}
  const digits = "pass it as a string of digits, which SQLite stores as that integer in an INTEGER column";
  if (driver === "durable-object") {throw new ParameterError(`A Durable Object's SQL storage binds no BigInt, and ${parameterValue} is past 2^53 - 1, where a number stops being exact: ${digits}.`);}
  throw new ParameterError(`sqlite3 binds a BigInt as NULL, and ${parameterValue} is past 2^53 - 1, where a number stops being exact: ${digits}, or run the statement on better-sqlite3, node:sqlite or libSQL, which bind a BigInt.`);
};

export const parameterName = (names: Readonly<string[]>, index: number): string => {
  const name = names[index];
  // A missing index still uses JavaScript's "undefined" property key during lookup.
  return matchesUndefined(name) ? "undefined" : name;
};

// A Durable Object's exec() refuses a BigInt ("Cannot convert a BigInt value to a number").
export const durableObjectValues = function durableObjectValues(query: QueryModule, names: Readonly<string[]>, values: unknown[]): unknown[] {
  return values.map((currentValue, index) => numberOrDigits(currentValue, query.inputs?.[parameterName(names, index)]?.type, "durable-object"));
};
