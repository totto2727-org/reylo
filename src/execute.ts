// Execute a compiled statement against a caller-supplied native driver.

import { bunRows, neonCallable, postgresJs, queryPostgres, slonik } from "./decode.ts";
import { mariadb, mysql2, planetscale } from "./decode-mysql.ts";
import { normalize, runDurableObject, runSyncSqlite, runTurso } from "./decode-sqlite.ts";
import { encodeDuckdb, isDuckdb, runDuckdb } from './decode-duckdb.ts';
import type { ClientFor, Dialect, DuckdbClient, ParamsInput, QueryModule, SyncClientFor } from './execute-types.ts';
import { describe, hstoreText, ParameterError, postgresInterval, postgresYear, zoned } from './values.ts';
import type { Columns } from './values.ts';
import type { EngineType } from "./engine-type.ts";
import { lexPlaceholders } from "./lex.ts";
import { withSqlcommenter } from "./sqlcommenter.ts";
import { differences, due, passed, staleError } from './fresh.ts';
import type { Fresh } from './fresh.ts';
import { hasFunctionType, hasObjectType, matchesBigInt, matchesBoolean, matchesNull, matchesNullish, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";

export type {
  BunSqlClient,
  CallableClient,
  ClientFor,
  D1Client,
  Dialect,
  DrizzleDatabase,
  DrizzleMysqlTransaction,
  DrizzlePgTransaction,
  DrizzleSqliteTransaction,
  DrizzleSyncSqliteTransaction,
  DuckdbClient,
  DurableObjectSql,
  DurableObjectStorage,
  Inputs,
  LibsqlClient,
  MariadbCallbackClient,
  MariadbClient,
  Mysql2CallbackClient,
  MysqlClient,
  MysqlExecuteClient,
  NeonHttpClient,
  ParamsInput,
  PgQueryClient,
  PostgresClient,
  QueryModule,
  SlonikClient,
  Sqlite3Client,
  SqliteClient,
  SqlitePromiseClient,
  SyncClientFor,
  SyncSqliteClient,
  TursoClient,
  UnsafeClient,
} from "./execute-types.ts";

type ClientMembers = Record<string, unknown>;
type DriverRows = PromiseLike<unknown[]>;
interface BunProtocol { unsafe: (text: string, params: unknown[]) => DriverRows }

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- A runtime member check selects the native driver protocol specified by the caller.
const inspectClient = <Protocol = object>(client: unknown): ClientMembers & Protocol =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Inspect native members and describe the calling protocol selected for their receiver.
  client as ClientMembers & Protocol;

// A SQLite-backed Durable Object's `ctx.storage.sql`: exec() and databaseSize, and no prepare().
// Sqlite3's Database has exec() too, beside all().
const isDurableObjectSql = function isDurableObjectSql(client: ClientMembers | null | undefined): boolean {
  return !matchesNullish(client) && hasFunctionType(client.exec) && !hasFunctionType(client.prepare) && !hasFunctionType(client.all) && "databaseSize" in client;
};

/**
 * The driver client a Drizzle database, transaction or savepoint runs on, which its session
 * keeps on `session.client` (the pool for a database, the transaction's own connection inside
 * one), or on `session.tx` inside a libSQL transaction, whose `client` stays the base client;
 * any other client as it is.
 *
 * @param {ClientMembers} currentClient - The supplied native client or Drizzle wrapper.
 * @returns {ClientMembers} The native receiver of the statement, preserving its transaction connection.
 */
const underneath = function underneath(currentClient: ClientMembers): ClientMembers {
  const session = !matchesNullish(currentClient) && hasObjectType(currentClient) && hasFunctionType(currentClient.select) ? currentClient.session : undefined;
  if (matchesNullish(session) || !hasObjectType(session)) {return currentClient;}
  const sessionMembers = inspectClient(session);
  if (matchesNullish(sessionMembers.dialect)) {return currentClient;}
  const client = inspectClient(sessionMembers.tx ?? sessionMembers.client ?? currentClient);
  // Drizzle-orm/durable-sqlite keeps the Durable Object's storage, whose SQL storage is its sql.
  const sql = inspectClient(client.sql);
  return isDurableObjectSql(sql) ? sql : client;
};

// Turso's promise API (@tursodatabase/database): a Database has connect() and
// MaxWriteReplicationIndex() in every release from 0.4 (0.4 has no all(), so it looked synchronous,
// And from 0.6 its all() took it for sqlite3's, whose callback it never calls); the Transaction
// That transactionAsync() hands its callback (0.7 and later) has all() beside batch(), which
// Sqlite3's database lacks. The compat Database has no connect().
const isTurso = function isTurso(client: ClientMembers): boolean {
  return hasFunctionType(client.prepare) && ((hasFunctionType(client.connect) && hasFunctionType(client.maxWriteReplicationIndex)) || (hasFunctionType(client.all) && hasFunctionType(client.batch)));
};

// A SQLite client with prepare() whose statements answer at once. D1 (batch()), sqlite3 and
// Sqlite (all() on the database), libSQL (execute()), Bun.sql (unsafe()) and Turso's promise API
// Are asynchronous. Turso's compat Database has batch() as D1 does, and answers at once; its
// MaxWriteReplicationIndex(), which every Database of Turso's has, tells it from D1's. A DuckDB
// Connection has prepare() too, answering through a promise, and runAndReadAll() beside it.
const isSyncSqlite = function isSyncSqlite(client: ClientMembers | null | undefined): boolean {
  return (
    !matchesNullish(client) &&
    hasFunctionType(client.prepare) &&
    !hasFunctionType(client.runAndReadAll) &&
    (!hasFunctionType(client.batch) || hasFunctionType(client.maxWriteReplicationIndex)) &&
    !hasFunctionType(client.all) &&
    !hasFunctionType(client.execute) &&
    !hasFunctionType(client.unsafe) &&
    !isTurso(client)
  );
};

// Slonik's pool, connections, transactions and savepoints, which have query() as pg's do but take
// Only the queries its sql tag builds (src/decode.ts, `slonik`).
const isSlonik = function (client: ClientMembers): boolean {
  return hasFunctionType(client.maybeOneFirst) && hasFunctionType(client.anyFirst);
};

const HEX_RADIX = 16;

const byteaHex = (bytes: Uint8Array): string =>
  Iterator.from(bytes).reduce(
    (hex, byte) => hex + (byte < HEX_RADIX ? "0" : "") + byte.toString(HEX_RADIX),
    String.raw`\x`,
  );

const asByteaHex = (candidate: unknown): unknown => candidate instanceof Uint8Array ? byteaHex(candidate) : candidate;

// The parameters are an object, refused before anything reaches the database otherwise: an
// Array, which `run` took in the order of `params` from 2026-10-03, was dropped on 2026-10-20
// (wiki/design.md §9), so the call says which key each value binds.
// oxlint-disable-next-line rules/no-type-predicate -- The synchronous parameter validator narrows its callers without loading the optional Effect runtime.
const checkParams: (query: QueryModule, input: unknown) => asserts input is Record<string, unknown> = function checkParams(query, input) {
  if (!matchesNull(input) && hasObjectType(input) && !Array.isArray(input)) {return;}
  const keys = query.params.map((name) => `${/^(?:[A-Za-z_$][\w$]*|\d+)$/u.test(name) ? name : JSON.stringify(name)}: ...`);
  const takes = keys.length ? `This statement takes { ${keys.join(", ")} }.` : "This statement takes none: leave them out.";
  throw new ParameterError(`The parameters must be an object keyed by parameter name, or by number for positional placeholders ({ 1: ..., 2: ... }); got ${Array.isArray(input) ? "an array" : String(input)}. ${takes}`);
};

/**
 * `text` as Reylo sends it: with the comment naming the query's file, where the module asks for one (src/sqlcommenter.ts).
 *
 * @param {QueryModule} query - The query module that controls the SQL comment.
 * @param {string} text - The statement after placeholder compilation.
 * @returns {string} The statement with the source comment when requested and available.
 */
export const sentText = function sentText(query: QueryModule, text: string): string {
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- Keep the native optional path check and its short-circuit evaluation before writing the source comment.
  return query.sqlcommenter === true && query.source?.length ? withSqlcommenter(text, query.source) : text;
};

/**
 * The checks a parameter needs (src/checks.ts): every build step passes them where its statement has such a parameter.
 *
 * @param {QueryModule} query - The query module that supplies the runtime checks.
 * @param {string} name - The name used in the diagnostic if the checks are missing.
 * @returns {NonNullable<QueryModule["checks"]>} The module's runtime checks.
 */
const checksFor = function checksFor(query: QueryModule, name: string): NonNullable<QueryModule["checks"]> {
  if (query.checks) {return query.checks;}
  throw new ParameterError(`Parameter "${name}" is a typed JSON, structured or cast parameter, which the run time checks with Reylo's checks; a query defined by hand passes them: defineQuery({ …, checks }) with checks from "@totto2727/reylo".`);
};

const FIRST_ARRAY_INDEX = 0;
const ARRAY_INDEX_STEP = 1;

const indexedElements = function* (array: Readonly<unknown[]>): Generator<[number, unknown]> {
  const cursor = { index: FIRST_ARRAY_INDEX };
  // Read the live length and each indexed value, including holes and inherited properties.
  while (cursor.index < array.length) {
    yield [cursor.index, array[cursor.index]];
    cursor.index += ARRAY_INDEX_STEP;
  }
};

/**
 * Where an array, or an array inside it (a multidimensional one), holds null or undefined: `[2]`, `[1][0]`.
 *
 * @param {Readonly<unknown[]>} array - The array to inspect, including its nested arrays.
 * @param {string} path - The index path of the parent array.
 * @returns {string | undefined} The first null or undefined element's index path, or undefined.
 */
const nullElement = function nullElement(array: Readonly<unknown[]>, path = ""): string | undefined {
  return Iterator.from(indexedElements(array))
    .map(([index, element]): string | undefined => {
      const location = `${path}[${index}]`;
      if (matchesNullish(element)) {return location;}
      return Array.isArray(element) ? nullElement(element, location) : undefined;
    })
    .find((candidate) => matchesString(candidate));
};

// oxlint-disable-next-line unicorn/no-null -- Native database bindings and JSON serialization use the JavaScript null value.
const NATIVE_NULL = null;

/**
 * Whether a parameter the statement takes no null for is declared with a type that takes no null: for a JSON one, whether the schema its type carries refuses JSON's null too.
 *
 * @param {QueryModule} query - The query module that provides JSON Schema validation.
 * @param {EngineType | undefined} type - The engine type of the parameter, if available.
 * @returns {boolean} True if the type cannot represent the supplied null.
 */
const refusesNull = function refusesNull(query: QueryModule, type: EngineType | undefined): boolean {
  if (matchesUndefined(type) || type.kind === "unknown") {return false;}
  if (type.kind !== "json") {return true;}
  return !matchesUndefined(type.schema) && !matchesUndefined(query.checks) && !matchesUndefined(query.checks.validate(type.schema, NATIVE_NULL));
};

/**
 * A parameter the statement takes no null for, given null or left out.
 *
 * @param {string} name - The parameter name shown in the diagnostic.
 * @param {unknown} parameterValue - The null or missing value that caused the error.
 */
const refuseNull = function refuseNull(name: string, parameterValue: unknown): never {
  throw new ParameterError(`Parameter "${name}" ${matchesUndefined(parameterValue) ? "is missing" : "is null"}, and the statement takes no null for it: pass a value.`);
};

const value = function value(params: Record<string, unknown>, name: string): unknown {
  const suppliedValue = params[name];
  return matchesUndefined(suppliedValue) ? NATIVE_NULL : suppliedValue;
};

// A binary parameter is typed Uint8Array, and every driver binds one as it is (pg-promise too,
// Since it gets { text, values }) but two (lab/driver-matrix, S1c). mariadb writes any value
// That is not a Buffer as JSON, so a plain Uint8Array (TextEncoder's, getRandomValues') arrived
// As the text {"0":1,"1":2,"2":255}: it gets a Buffer over the same memory, where a Buffer
// Exists (not in every Worker). Neon's neon() before 0.10 sends a Buffer as JSON as well, so it
// Gets Postgres's hex form, `\x0102ff`, which 0.10 and later send for a Buffer themselves.
const asBuffer = function asBuffer(binaryValue: unknown): unknown {
  // Named structurally, so that a project without Node's types can type-check the module.
  const NodeBuffer = (globalThis as { Buffer?: { isBuffer: (candidate: unknown) => boolean; from: (buffer: ArrayBufferLike, offset: number, length: number) => Uint8Array } }).Buffer;
  return binaryValue instanceof Uint8Array && !matchesUndefined(NodeBuffer) && !NodeBuffer.isBuffer(binaryValue) ? NodeBuffer.from(binaryValue.buffer, binaryValue.byteOffset, binaryValue.byteLength) : binaryValue;
};

const isJson = (kind: EngineType["kind"] | undefined): boolean => kind === "json" || kind === "object" || kind === "list" || kind === "rows";

// A JSON parameter's value is a JavaScript value, which reaches the database as its JSON text
// (JSON.stringify), so a string is a JSON string on every driver; null is SQL NULL where the
// Statement takes SQL NULL for the parameter, and JSON's null elsewhere (`JSON_NULL`). Each driver
// Left to itself did something else (wiki/driver-decoding.md, 2026-10-12): pg wrote an array as
// An array literal and a string as raw JSON text, mariadb expanded an array into a list, the
// SQLite drivers refused an object, and mysql2 bound 5 as 5.0.
const isJsonValue = function isJsonValue(query: QueryModule, name: string, parameterValue: unknown): boolean {
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
const JSON_NULL: unique symbol = Symbol("JSON null");

/**
 * A JSON parameter's value as JSON: `JSON_NULL` as null.
 *
 * @param {unknown} candidate - The JavaScript value or internal marker for JSON null.
 * @returns {unknown} The JavaScript value used for JSON serialization.
 */
const jsonValue = (candidate: unknown): unknown => candidate === JSON_NULL ? NATIVE_NULL : candidate;

/**
 * A JSON parameter's value as the JSON text a driver binds.
 *
 * @param {unknown} candidate - The parameter before serialization.
 * @returns {string} The JSON text sent to a driver that accepts encoded JSON.
 */
const jsonText = (candidate: unknown): string => JSON.stringify(jsonValue(candidate));

// A date or time value's type says whether it has a zone (src/render.ts),
// And a value that would be read in a zone nobody chose is refused before the
// Statement runs. A `timestamp` or a `date` (MySQL's DATETIME and TIMESTAMP are the engine's
// `timestamp`) takes no Date: pg and mysql2 wrote its wall-clock time in the app's zone,
// Postgres.js in the server's, PGlite and Bun.sql in UTC, and Bun.sql's `date` failed in every
// Zone. A `timestamptz` takes a string that names its zone, which is what `run` returns for one:
// Without a zone the server reads the text in the session's TimeZone, which the driver or the
// Server sets, and a Date is refused too, as every other type's value is but a string,
// With the call that writes it as one.

const isTime = (type: EngineType | undefined): boolean => type?.kind === "scalar" && type.name.split("|").every((part) => part === "timestamp" || part === "timestamptz" || part === "date");

const checkZonedTime = (name: string, parameterValue: unknown): void => {
  if (parameterValue instanceof Date) {
    throw new ParameterError(`Parameter "${name}" is a timestamptz, which takes the instant as a string that names its zone, as \`.run()\` returns one, not a Date: pass date.toISOString() ("2026-10-12T19:06:48.282Z").`);
  }
  if (matchesString(parameterValue) && !zoned.test(parameterValue.trim())) {
    throw new ParameterError(`Parameter "${name}" is a timestamptz, an instant, so a string for it names its zone ("2026-10-12T19:06:48.282Z", "2026-10-12 19:06:48+09", "2026-10-12 19:06:48 America/Los_Angeles"); got ${JSON.stringify(parameterValue)}, which the server would read in the session's time zone.`);
  }
};

const checkTime = function checkTime(type: EngineType | undefined, name: string, parameterValue: unknown): void {
  if (matchesUndefined(type) || matchesNullish(parameterValue)) {return;}
  if (type.kind === "array") {
    if (Array.isArray(parameterValue)) {Iterator.from(parameterValue).forEach((element) => {checkTime(Array.isArray(element) ? type : type.of, name, element);});}
    return;
  }
  if (type.kind !== "scalar") {return;}
  if (type.name === "timestamptz") {
    checkZonedTime(name, parameterValue);
    return;
  }
  if (parameterValue instanceof Date && type.name.split("|").every((part) => part === "timestamp" || part === "date")) {
    throw new ParameterError(`Parameter "${name}" is a ${type.name === "date" ? "date" : "timestamp"} without a time zone, so it takes the wall-clock text ("2026-10-12 19:06:48.282", "2026-10-12"), not a Date: drivers write a Date's time in different zones (the app's, the server's or UTC).`);
  }
};

// A binary parameter takes a Uint8Array (a Buffer is one), as `.run()` returns binary data and
// As a structured parameter's binary member does (src/rows.ts). Anything else would reach the
// Driver as it is, and a string means something different on each database: Postgres reads it
// As bytea's hex or escape text, MySQL stores the bytes of its UTF-8, and SQLite stores it as
// TEXT, which comes back a string. So base64 text was stored as its own letters.
const checkBinary = function checkBinary(type: EngineType | undefined, name: string, parameterValue: unknown): void {
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

const encode = ({ dialect, name }: { dialect: Dialect; name: string }, type: EngineType | undefined, parameterValue: unknown): unknown => {
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
const numberOrDigits = function numberOrDigits(parameterValue: unknown, type: EngineType | undefined, driver: "sqlite3" | "durable-object"): unknown {
  if (!matchesBigInt(parameterValue)) {return parameterValue;}
  if (parameterValue >= BigInt(Number.MIN_SAFE_INTEGER) && parameterValue <= BigInt(Number.MAX_SAFE_INTEGER)) {return Number(parameterValue);}
  if (type?.kind === "scalar" && type.name === "int8") {return String(parameterValue);}
  const digits = "pass it as a string of digits, which SQLite stores as that integer in an INTEGER column";
  if (driver === "durable-object") {throw new ParameterError(`A Durable Object's SQL storage binds no BigInt, and ${parameterValue} is past 2^53 - 1, where a number stops being exact: ${digits}.`);}
  throw new ParameterError(`sqlite3 binds a BigInt as NULL, and ${parameterValue} is past 2^53 - 1, where a number stops being exact: ${digits}, or run the statement on better-sqlite3, node:sqlite or libSQL, which bind a BigInt.`);
};

const parameterName = (names: Readonly<string[]>, index: number): string => {
  const name = names[index];
  // A missing index still uses JavaScript's "undefined" property key during lookup.
  return matchesUndefined(name) ? "undefined" : name;
};

// A Durable Object's exec() refuses a BigInt ("Cannot convert a BigInt value to a number").
const durableObjectValues = function durableObjectValues(query: QueryModule, names: Readonly<string[]>, values: unknown[]): unknown[] {
  return values.map((currentValue, index) => numberOrDigits(currentValue, query.inputs?.[parameterName(names, index)]?.type, "durable-object"));
};

const CLOCK_FIELD_WIDTH = 2;
const YEAR_FIELD_WIDTH = 4;
const MILLISECOND_FIELD_WIDTH = 3;
const FIRST_AD_YEAR = 1;
const FIRST_CALENDAR_MONTH = 1;
const MINUTES_PER_HOUR = 60;
const ZERO_ZONE_OFFSET = 0;

const padClockField = (field: number, width = CLOCK_FIELD_WIDTH): string => String(field).padStart(width, "0");

/**
 * Pg's `dateToString`: the local date and time to the millisecond, then the offset; BC for a year before 1.
 *
 * @param {Date} date - The Date to read in local time.
 * @returns {string} Postgres date and time text with its local offset.
 */
const dateText = function dateText(date: Date): string {
  const year = date.getFullYear();
  const offset = -date.getTimezoneOffset();
  const absoluteOffset = Math.abs(offset);
  const beforeEra = year < FIRST_AD_YEAR;
  const yearText = padClockField(beforeEra ? FIRST_AD_YEAR - year : year, YEAR_FIELD_WIDTH);
  const calendarDay = `${padClockField(date.getMonth() + FIRST_CALENDAR_MONTH)}-${padClockField(date.getDate())}`;
  const time = `${padClockField(date.getHours())}:${padClockField(date.getMinutes())}:${padClockField(date.getSeconds())}.${padClockField(date.getMilliseconds(), MILLISECOND_FIELD_WIDTH)}`;
  const zone = `${offset < ZERO_ZONE_OFFSET ? "-" : "+"}${padClockField(Math.floor(absoluteOffset / MINUTES_PER_HOUR))}:${padClockField(absoluteOffset % MINUTES_PER_HOUR)}`;
  return `${yearText}-${calendarDay}T${time}${zone}${beforeEra ? " BC" : ""}`;
};

// oxlint-disable-next-line typescript/no-base-to-string -- Match pg's native string coercion for untyped scalar parameters.
const postgresScalarText = (element: unknown): string => hasObjectType(element) ? JSON.stringify(element) : String(element);

/**
 * A Postgres array literal, written as pg writes one (`arrayString` in pg/lib/utils.js): a nested
 * array in braces, null and undefined as NULL, binary data as `\\x` and its hex, and every other
 * element quoted, with `"` and `\` escaped: a Date as its local time and offset, an object as
 * its JSON, anything else as its string. The elements are separated by `delim`, the element type's
 * delimiter: the server reads `{"a","b"}` as one element of a `geometry[]`, whose delimiter is `:`.
 *
 * @param {Readonly<unknown[]>} array - The array of SQL values, including nested arrays.
 * @param {string} delim - The separator that the element type uses.
 * @returns {string} A Postgres array literal with the elements escaped.
 */
export const arrayLiteral = function arrayLiteral(array: Readonly<unknown[]>, delim = ","): string {
  const text = (element: unknown): string => {
    if (matchesNullish(element)) {return "NULL";}
    if (Array.isArray(element)) {return arrayLiteral(element, delim);}
    if (ArrayBuffer.isView(element)) {
      return `\\${byteaHex(new Uint8Array(element.buffer, element.byteOffset, element.byteLength))}`;
    }
    const scalar = element instanceof Date ? dateText(element) : postgresScalarText(element);
    return `"${scalar.replaceAll(/[\\"]/gu, String.raw`\$&`)}"`;
  };
  const items = Iterator.from(indexedElements(array))
    .reduce((out, [index, element]) => (index ? out + delim : out) + text(element), "{");
  return `${items}}`;
};

// A value as Slonik's sql tag takes it, which is a string, a number, a boolean, a BigInt or null:
// The rest as pg would write them, binary data as `\x` and its hex, an array as its literal, a
// Date as its instant, and an object as its JSON. An omitted parameter binds NULL, as on pg.
const slonikParam = function (parameterValue: unknown): unknown {
  if (matchesNullish(parameterValue)) {return NATIVE_NULL;}
  if (parameterValue instanceof Uint8Array) {return byteaHex(parameterValue);}
  if (Array.isArray(parameterValue)) {return arrayLiteral(parameterValue);}
  if (parameterValue instanceof Date) {return parameterValue.toISOString();}
  return hasObjectType(parameterValue) ? JSON.stringify(parameterValue) : parameterValue;
};

const postgresTypedArray = (values: unknown[], type: Extract<EngineType, { kind: "array" }>): string =>
  arrayLiteral(isJson(type.of.kind) ? values.map((element) => (matchesNullish(element) ? element : JSON.stringify(element))) : values, type.delimiter);

const untypedPostgresText = (parameterValue: unknown): string => {
  if (Array.isArray(parameterValue)) {return arrayLiteral(parameterValue);}
  if (parameterValue instanceof Uint8Array) {return byteaHex(parameterValue);}
  if (matchesBoolean(parameterValue)) {return parameterValue ? "t" : "f";}
  if (parameterValue instanceof Date) {return dateText(parameterValue);}
  return postgresScalarText(parameterValue);
};

/**
 * A bound value as the text Postgres's input function reads, as `.run()` sends it through pg.
 *
 * @param {QueryModule} query - The query module that describes the value's engine type.
 * @param {string} name - The name used to look up the parameter.
 * @param {unknown} parameterValue - The bound JavaScript value.
 * @returns {string | null} The input text accepted by Postgres, or null for SQL NULL.
 */
const postgresText = function postgresText(query: QueryModule, name: string, parameterValue: unknown): string | null {
  if (matchesNullish(parameterValue)) {return NATIVE_NULL;}
  const inputType = query.inputs?.[name]?.type;
  if (Array.isArray(parameterValue) && inputType?.kind === "array") {return postgresTypedArray(parameterValue, inputType);}
  if (isJsonValue(query, name, parameterValue)) {return jsonText(parameterValue);}
  return untypedPostgresText(parameterValue);
};

const MISSING_PARAMETER = -1;
const FIRST_NUMBERED_PARAMETER = 1;

const indexOf = function indexOf(query: QueryModule, placeholder: { name: string; start: number; end: number }): number {
  const index = query.params.indexOf(placeholder.name);
  // A hand-built query whose `params` misses a placeholder would bind `$0`.
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native error for a hand-built module whose binding list is incomplete.
  if (index === MISSING_PARAMETER) {throw new Error(`The statement's placeholder ${query.sql.slice(placeholder.start, placeholder.end)} is parameter "${placeholder.name}", which the query's params (${JSON.stringify(query.params)}) do not list.`);}
  return index;
};

interface CompiledStatement {
  order: Readonly<string[]>;
  text: string;
}

const compiledStatement = (text: string, order: Readonly<string[]>): CompiledStatement =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the compiled statement's observable text and binding order keys.
  ({ text, order });

/**
 * The statement as Reylo sends it to the database, and the parameter each placeholder binds: the
 * engine's compiled text where a build step wrote one into the module. Without it (a query
 * defined by hand) the run time lexes the placeholders itself (`lex.ts`); the engine's lexer is
 * the authoritative one, and the two agree on every statement the fallback is meant for.
 * Postgres numbers each distinct parameter once; MySQL has only `?`, and better-sqlite3 reads
 * SQLite's `?NNN` as a named parameter, so both get one `?` per placeholder and a repeated name is
 * repeated in the binding order.
 *
 * @param {QueryModule} query - The module with either raw SQL or a compiled statement.
 * @returns {{ text: string, order: Readonly<string[]> }} The statement and the parameter names in binding order.
 */
export const compile = function compile(query: QueryModule): CompiledStatement {
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- Keep the cached plan's short-circuit lookup and compile raw SQL when cached text is empty.
  if (query.text?.length && query.order) {return compiledStatement(query.text, query.order);}
  const { placeholders } = lexPlaceholders(query.sql, query.dialect);
  // Postgres and DuckDB number each distinct parameter once.
  const numbered = query.dialect === "postgres" || query.dialect === "duckdb";
  const rewritten = { offset: 0, text: "" };
  const order: string[] = [];
  Iterator.from(placeholders).forEach((placeholder) => {
    const index = indexOf(query, placeholder);
    rewritten.text += query.sql.slice(rewritten.offset, placeholder.start) + (numbered ? `$${index + FIRST_NUMBERED_PARAMETER}` : "?");
    order.push(placeholder.name);
    rewritten.offset = placeholder.end;
  });
  return compiledStatement(rewritten.text + query.sql.slice(rewritten.offset), numbered ? query.params : order);
};

// The rows are bound positionally in every dialect. A value left out binds NULL, as pg,
// PGlite, better-sqlite3 and Bun.sql already do; postgres.js, mysql2, node:sqlite and libSQL
// Would reject it instead.
interface BoundStatement {
  names: Readonly<string[]>;
  text: string;
  values: unknown[];
}

const statement = function statement(query: QueryModule, params: ParamsInput): BoundStatement {
  // The build step already compiled the statement; only the values need ordering.
  const compiled = compile(query);
  const bound: BoundStatement = { text: compiled.text, values: compiled.order.map((name) => value(params, name)), names: compiled.order };
  bound.names.forEach((name, index) => {
    const input = query.inputs?.[name];
    const type = input?.type;
    // A typed JSON parameter (`:p::jsonb('…')`): a value left out takes the schema's default, a
    // Key under `properties` too, and the value is checked against the schema before the
    // Statement runs (wiki/typed-json-params.md). Null is SQL NULL where the statement takes SQL
    // NULL for the parameter, and elsewhere JSON's null, where the schema admits it; a value left
    // Out there is refused.
    const schema = input?.schema;
    if (!matchesUndefined(schema)) {
      let parameterValue = params[name];
      const { cloneJson, validate, withDefaults } = checksFor(query, name);
      if (matchesUndefined(parameterValue) && !matchesNull(schema) && hasObjectType(schema) && "default" in schema) {parameterValue = cloneJson(schema.default);}
      if (!matchesUndefined(parameterValue) && !matchesNull(parameterValue)) {
        parameterValue = withDefaults(schema, parameterValue);
        const failure = validate(schema, parameterValue);
        if (failure) {throw new ParameterError(`Parameter "${name}"${failure.path ? ` at ${failure.path}` : ""} ${failure.message}.`);}
      } else if (input?.nullable === false) {
        if (matchesUndefined(parameterValue) || validate(schema, NATIVE_NULL)) {refuseNull(name, parameterValue);}
        parameterValue = JSON_NULL;
      }
      bound.values[index] = matchesUndefined(parameterValue) ? NATIVE_NULL : parameterValue;
      return;
    }
    // A structured parameter is checked against its column list and written as the JSON the
    // Statement reads; in an insert, its lists name only the keys the call carries. It refuses
    // Null itself, saying what to pass.
    if (type?.kind === "rows") {
      const structured = query.structured?.find((candidate) => candidate.name === name);
      const { prepareRows, variant } = checksFor(query, name);
      const prepared = prepareRows(name, type, bound.values[index], query.dialect, !matchesUndefined(structured));
      bound.values[index] = prepared.value;
      if (structured) {bound.text = variant(bound.text, structured, type.fields, prepared.present);}
      return;
    }
    // A parameter the statement takes no null for, which its types rely on (a column it alone
    // Fills, an expression of it typed non-null), refuses null and refuses to be left out, which
    // Would bind NULL: exactly where its declared type takes no null (src/render.ts,
    // `renderParamType`). One typed `unknown` is declared `unknown` and takes anything. A JSON one
    // Takes JSON's null there instead, unless the schema its type carries refuses null, and is
    // Refused only when left out.
    let jsonNull = false;
    if (input?.nullable === false && matchesNull(bound.values[index])) {
      if (type?.kind === "json" && !matchesUndefined(params[name]) && !refusesNull(query, type)) {jsonNull = true;}
      else if (type?.kind === "json" || refusesNull(query, type)) {refuseNull(name, params[name]);}
    }
    // An array parameter takes no NULL element, as its type says (`:ids::int[]` is `number[]`):
    // A NULL in `= any(:ids)` matches nothing. An array inside a
    // Structured parameter's member keeps its NULL elements (src/rows.ts).
    if (type?.kind === "array" && Array.isArray(bound.values[index])) {
      const at = nullElement(bound.values[index] as unknown[]);
      if (!matchesUndefined(at)) {throw new ParameterError(`Parameter "${name}" is an array whose elements may not be null, and the element at ${at} is. Leave it out of the array.`);}
    }
    // A `::type` written on MySQL or SQLite, whose cast turns a value it cannot read into 0 or
    // NULL: the value is checked against the type as written.
    const cast = query.inputs?.[name]?.cast;
    if (!matchesUndefined(cast) && !matchesUndefined(type)) {checksFor(query, name).checkCast(name, cast, type, bound.values[index], query.dialect);}
    checkTime(type, name, bound.values[index]);
    checkBinary(type, name, bound.values[index]);
    bound.values[index] = jsonNull ? JSON_NULL : encode({ dialect: query.dialect, name }, type, bound.values[index]);
  });
  // Every MySQL and SQLite driver binds JSON text as text, which the database reads as JSON (a
  // Structured parameter's is written already).
  if (query.dialect !== "postgres") {bound.values = bound.values.map((currentValue, index) => (isJsonValue(query, parameterName(bound.names, index), currentValue) && query.inputs?.[parameterName(bound.names, index)]?.type.kind !== "rows" ? jsonText(currentValue) : currentValue));}
  // The comment naming the file goes on last, after a structured parameter's lists are written.
  bound.text = sentText(query, bound.text);
  return bound;
};

const verifyFreshness = (query: QueryModule, fresh: Fresh, rows: unknown[] | undefined): void => {
  const changes = (rows && differences(fresh, rows, query.dialect)) ?? [];
  if (changes.length) {throw staleError(query.source, changes);}
  passed(query);
};

const readSqliteCatalog = (client: ClientMembers, fresh: Fresh): unknown[] | undefined => {
  try {
    return isDurableObjectSql(client)
      ? inspectClient<{ exec: (sql: string) => { toArray: () => unknown[] } }>(client).exec(fresh.query).toArray()
      : inspectClient<{ prepare: (sql: string) => { all: () => unknown[] } }>(client).prepare(fresh.query).all();
  } catch {
    // The caller's role can lack catalog access. It can still run the actual query.
    return undefined;
  }
};

const executeSyncSqlite = function executeSyncSqlite(client: ClientMembers, query: QueryModule, params: ParamsInput): unknown[] | Promise<unknown[]> {
  checkParams(query, params);
  const { fresh } = query;
  if (fresh && due(query)) {
    verifyFreshness(query, fresh, readSqliteCatalog(client, fresh));
  }

  const { text, values, names } = statement(query, params);
  if (isDurableObjectSql(client)) {return runDurableObject(client, text, durableObjectValues(query, names, values), query.columns);}
  return runSyncSqlite(client, text, values, query.columns);
};

const refuseSyncClient = (reason: string): TypeError =>
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native TypeError of the synchronous SQLite API without loading Effect.
  new TypeError(`runSync takes a synchronous SQLite client (better-sqlite3, node:sqlite, bun:sqlite, the Database of @tursodatabase/database/compat or a Durable Object's ctx.storage.sql); ${reason}. run takes every client.`);

/**
 * The synchronous path alone, for `runSync`: any other client is refused before anything runs.
 *
 * @param {SyncClientFor<D>} client - The synchronous SQLite client or transaction.
 * @param {QueryModule<D>} query - The module with the SQLite statement.
 * @param {ParamsInput} params - The values keyed by parameter name or position.
 * @returns {unknown[]} The decoded result rows, or an empty array if the statement returns none.
 */
export const executeSync = function executeSync<D extends Dialect>(client: SyncClientFor<D>, query: QueryModule<D>, params: ParamsInput = {}): unknown[] {
  const currentClient = underneath(inspectClient(client));
  if (query.dialect !== "sqlite") {throw refuseSyncClient(`a ${query.dialect} statement has none`);}
  if (!isSyncSqlite(currentClient) && !isDurableObjectSql(currentClient)) {throw refuseSyncClient("this client answers through a promise");}
  const rows = executeSyncSqlite(currentClient, query, params);
  if (Array.isArray(rows)) {return rows;}
  // oxlint-disable-next-line promise/prefer-await-to-then -- This synchronous API consumes the incompatible driver's rejection before throwing its own TypeError.
  rows.catch(() => {
    // The synchronous TypeError below already reports the incompatible driver.
  });
  throw refuseSyncClient("this client's statement answered with a promise");
};

/**
 * The statement and its values in the database's raw form, which a Standard Query's `encode`
 * returns (src/standard-query.ts), bound as `.run()` binds them, its checks included: on Postgres
 * each value's text, which a driver binds with no declared type, so the server reads it as the
 * parameter's type; on MySQL and SQLite each value as a driver binds it.
 *
 * @param {QueryModule} query - The module with the statement and its metadata.
 * @param {unknown} params - The values keyed by parameter name or position.
 * @returns {{ text: string, values: unknown[] }} The compiled statement and encoded values in binding order.
 */
export const rawStatement = function rawStatement(query: QueryModule, params: unknown): { text: string; values: unknown[] } {
  checkParams(query, params);
  const { text, values, names } = statement(query, params);
  if (query.dialect !== "postgres") {return { text, values };}
  return { text, values: values.map((currentValue, index) => postgresText(query, parameterName(names, index), currentValue)) };
};

const accepted: Record<Dialect, string> = {
  duckdb: "runAndReadAll(sql, values) as on @duckdb/node-api's DuckDBConnection",
  mysql: "execute(text, values) as on mysql2 and PlanetScale; query(text, values) as on mariadb's pool or connection, from its promise or callback API; unsafe(text, values) as on Bun.sql; a mysql2 callback pool or connection; or a Drizzle database over one of them",
  postgres: "query(text, values) as on pg, PGlite, Neon and pg-promise; unsafe(text, values) as on postgres.js and Bun.sql; Neon's neon() function; a Slonik pool, connection or transaction; or a Drizzle database over one of them",
  sqlite: "prepare(sql) as on better-sqlite3, node:sqlite, bun:sqlite, Turso's @tursodatabase/database and Cloudflare D1; exec(sql, ...values) as on a Durable Object's ctx.storage.sql; execute({ sql, args }) as on @libsql/client; all(sql, params) as on sqlite3 and sqlite; unsafe(text, values) as on Bun.sql; or a Drizzle database over one of them",
};

const MAX_DRIVER_METHODS_IN_DIAGNOSTIC = 12;

const clientMethods = (candidate: object): Set<string> => {
  const names = new Set<string>();
  const chain: { current: object | null } = { current: candidate };
  while (chain.current && chain.current !== Object.prototype && chain.current !== Function.prototype) {
    const { current } = chain;
    Iterator.from(Object.getOwnPropertyNames(current)).forEach((key) => {
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (key !== "constructor" && hasFunctionType(property?.value)) {names.add(key);}
    });
    chain.current = Reflect.getPrototypeOf(current);
  }
  return names;
};

const seenClient = (candidate: unknown): string => {
  if (matchesNull(candidate) || (!hasObjectType(candidate) && !hasFunctionType(candidate))) {return String(candidate);}
  const names = clientMethods(candidate);
  if (!names.size) {return "an object with no methods";}
  const preview = Iterator.from(names).take(MAX_DRIVER_METHODS_IN_DIAGNOSTIC).toArray().join(", ");
  const more = names.size > MAX_DRIVER_METHODS_IN_DIAGNOSTIC ? ", ..." : "";
  return `an object with ${preview}${more}`;
};

const ORM_TRANSACTION_HINT = " and does not hand out its transaction's connection: take the transaction from the driver's client instead.";

const ormHint = (client: ClientMembers | undefined): string => {
  // Kysely and Prisma decode raw query values and keep their transaction connections private.
  if (hasFunctionType(client?.selectFrom) && hasFunctionType(client.executeQuery)) {
    const hint = client.isTransaction === true ? ORM_TRANSACTION_HINT : ": pass the pool or database its dialect was made with.";
    return ` Kysely decodes the values of its queries itself${hint}`;
  }
  if (hasFunctionType(client?.$queryRawUnsafe)) {
    const hint = hasFunctionType(client.$transaction) ? ": pass a client of your database's driver, such as the pool its driver adapter was made with." : ORM_TRANSACTION_HINT;
    return ` Prisma decodes the values of its queries itself${hint}`;
  }
  return "";
};

const clientHint = (candidate: unknown, dialect: Dialect): string => {
  const client = matchesNullish(candidate) ? undefined : inspectClient<{ db?: { prepare?: unknown } }>(candidate);
  if (dialect !== "duckdb" && isDuckdb(inspectClient(candidate))) {
    return ` It is a DuckDB connection, and the statement is typed for ${dialect}: set the project's URL to the DuckDB database (duckdb:./app.duckdb).`;
  }
  // Node:sqlite's tag store keeps its native database on db.
  if (hasFunctionType(client?.db?.prepare)) {return " A tag store is not a client: pass its database, store.db.";}
  return ormHint(client);
};

const unsupported = (candidate: unknown, dialect: Dialect): TypeError => {
  const seen = seenClient(candidate);
  const hint = clientHint(candidate, dialect);
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native TypeError for unsupported clients without loading Effect.
  return new TypeError(`reylo cannot run a ${dialect} statement on ${seen}. It takes a client with ${accepted[dialect]}.${hint}`);
};

const inputTypeAt = (query: QueryModule, names: Readonly<string[]>, index: number): EngineType | undefined =>
  query.inputs?.[parameterName(names, index)]?.type;

  // Postgres.js reads a string for a date or time parameter through `new Date(x)` and binds
  // Its toISOString(), so a timestamp's wall-clock time moved by the app's offset, and
  // `infinity` or a zone name failed with "Invalid time value". Declared `unknown` (705), it
  // Is sent as the text, which the server reads as the parameter's type, as it would an
  // Undeclared one. Bun.sql (commitDistributed()) sends the text and has no typed().
  // A JSON parameter goes to postgres.js as its JSON text declared `unknown` too: its own
  // Serializer would write a value as JSON, but a client Drizzle wraps has that serializer
  // Replaced by one that passes the value through (drizzle-orm/postgres-js), and a
  // Transaction shows neither. Bun.sql serializes the value itself.
const UNKNOWN_POSTGRES_OID = 705;

const executePostgresUnsafe = async (client: ClientMembers, query: QueryModule, bound: BoundStatement): Promise<unknown[]> => {
  const bun = hasFunctionType(client.commitDistributed);
  const asText = hasFunctionType(client.typed) && !bun;
  const postgres = inspectClient<{ typed: (value: unknown, oid: number) => unknown }>(client);
  const mapped = bound.values.map((parameter, index) => {
    if (isJsonValue(query, parameterName(bound.names, index), parameter)) {
      return asText ? postgres.typed(jsonText(parameter), UNKNOWN_POSTGRES_OID) : { toJSON: () => jsonValue(parameter) };
    }
    if (asText && matchesString(parameter) && isTime(inputTypeAt(query, bound.names, index))) {
      return postgres.typed(parameter, UNKNOWN_POSTGRES_OID);
    }
    return parameter;
  });
  return bun
    ? bunRows(await inspectClient<BunProtocol>(client).unsafe(bound.text, mapped), query.columns)
    : postgresJs(client, bound.text, mapped, query.columns);
};

  // A JSON parameter goes to pg's family, PGlite and Neon as its JSON text, and to postgres.js
  // As its JSON text declared `unknown` (below). Bun.sql serializes a value for a JSON
  // Parameter itself, so JSON text would be stored as a JSON string, and it types a boolean,
  // A number or an array of either by its JavaScript type ("cannot cast type boolean to
  // Jsonb"): it gets an object whose toJSON() returns the value, which it binds as JSON and
  // Serializes to exactly its JSON text. So does an unsafe() client without typed().
const postgresJsonBindings = (query: QueryModule, { names, values }: BoundStatement): unknown[] =>
  values.map((parameter, index) => (isJsonValue(query, parameterName(names, index), parameter) ? jsonText(parameter) : parameter));

const executePostgres = async (client: ClientMembers, query: QueryModule, input: BoundStatement): Promise<unknown[]> => {
  // An array for a SQL array parameter goes as its literal text, which the server reads as
  // The parameter's type, written as pg writes it: Bun.sql binds no JavaScript array
  // (`any($1)` failed with "insufficient data left in message"), postgres.js types an
  // Array by its first element ("cannot cast type boolean to boolean[]" for `$1::bool[]`),
  // And the copy of pg inside Neon's Pool and Client threw on a Uint8Array element and
  // Left the connection out of step. Each element of a `jsonb[]` is a JSON value.
  const bound: BoundStatement = { ...input, values: input.values.map((parameter, index) => {
    const type = inputTypeAt(query, input.names, index);
    return Array.isArray(parameter) && type?.kind === "array" ? postgresTypedArray(parameter, type) : parameter;
  }) };
  // Slonik takes only queries built by its SQL tag.
  if (isSlonik(client)) {return slonik(client, bound.text, postgresJsonBindings(query, bound).map((parameter) => slonikParam(parameter)), query.columns);}
  // Neon's template helper also has unsafe(), which builds a fragment without running it.
  if (hasFunctionType(client.query)) {return queryPostgres(client, bound.text, postgresJsonBindings(query, bound), query.columns);}
  if (hasFunctionType(client.unsafe)) {return executePostgresUnsafe(client, query, bound);}
  if (hasFunctionType(client)) {
    return neonCallable(client, bound.text, postgresJsonBindings(query, bound).map((parameter) => asByteaHex(parameter)), query.columns);
  }
  throw unsupported(client, query.dialect);
};

const executeMysql = async (client: ClientMembers, query: QueryModule, { text, values }: BoundStatement): Promise<unknown[]> => {
  if (hasFunctionType(client.unsafe)) {return bunRows(await inspectClient<BunProtocol>(client).unsafe(text, values), query.columns);}
  // Mariadb, checked before execute() because it has one too (returning rows, not a pair).
  // Its callback API (mariadb/callback) answers through the callback and returns a command
  // Object; its promise API returns a promise and ignores the callback.
  if (hasFunctionType(client.batch) && hasFunctionType(client.query)) {return mariadb(client, text, values.map((parameter) => asBuffer(parameter)), query.columns);}
  // Mysql2's callback API: the promise() wrapper runs on the same connection.
  const mysqlClient = hasFunctionType(client.promise)
    ? inspectClient<{ promise: () => ClientMembers }>(client).promise()
    : client;
  if (hasFunctionType(mysqlClient.execute)) {
    // Mysql2 has query() beside execute(); PlanetScale's Connection, Client and transaction do not.
    return hasFunctionType(mysqlClient.query) ? mysql2(mysqlClient, text, values, query.columns) : planetscale(mysqlClient, text, values, query.columns);
  }
  throw unsupported(client, query.dialect);
};

const executeDuckdb = async (client: ClientMembers, query: QueryModule, { text, values, names }: BoundStatement): Promise<unknown[]> => {
  // @duckdb/node-api's DuckDBConnection: each value given its kind by the result's own types (decode-duckdb.ts).
  if (isDuckdb(client)) {return runDuckdb(inspectClient<DuckdbClient>(client), text, values, names.map((_name, index) => inputTypeAt(query, names, index)), query.columns);}
  throw unsupported(client, query.dialect);
};

const sqlite3Bindings = (query: QueryModule, { names, values }: BoundStatement): unknown[] =>
  // The sqlite wrapper uses sqlite3, which otherwise binds a BigInt as NULL.
  values.map((parameter, index) => numberOrDigits(parameter, inputTypeAt(query, names, index), "sqlite3"));

const sqlite3Rows = async (client: ClientMembers, text: string, values: unknown[]): Promise<unknown[]> => {
  type Callback = (error: Error | null, rows: unknown[]) => void;
  const sqlite = inspectClient<{ all: (text: string, values: unknown[], done: Callback) => void }>(client);
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  try {
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- The native sqlite3 method supplies its result through this callback.
    sqlite.all(text, values, (error, rows) => {
      if (error) {reject(error);}
      else {resolve(rows);}
    });
  } catch (error) {
    reject(error);
  }
  return promise;
};

const preparedSqlite = async (client: ClientMembers, { text, values }: BoundStatement, columns: Columns | undefined): Promise<unknown[]> => {
  const prepared = inspectClient<{ prepare: (text: string) => ClientMembers }>(client).prepare(text);
  if (hasFunctionType(prepared.first)) {
    const d1 = inspectClient<{ bind: (...values: unknown[]) => { all: () => PromiseLike<{ results: unknown[] }> } }>(prepared);
    const bound = d1.bind(...values);
    const result = await bound.all();
    return normalize(result.results, columns, { d1: true });
  }
  const preparedStatement = inspectClient<{ all: (...values: unknown[]) => DriverRows }>(prepared);
  return normalize(await preparedStatement.all(...values), columns);
};

const executeSqliteStatements = async (
  client: ClientMembers,
  bound: BoundStatement,
  { columns, query }: { columns: Columns | undefined; query: QueryModule },
): Promise<unknown[]> => {
  if (hasFunctionType(client.getDatabaseInstance)) {
    const sqlite = inspectClient<{ all: (text: string, values: unknown[]) => DriverRows }>(client);
    return normalize(await sqlite.all(bound.text, sqlite3Bindings(query, bound)), columns);
  }
  if (hasFunctionType(client.all) && hasFunctionType(client.exec)) {
    return normalize(await sqlite3Rows(client, bound.text, sqlite3Bindings(query, bound)), columns);
  }
  if (hasFunctionType(client.prepare)) {return preparedSqlite(client, bound, columns);}
  throw unsupported(client, query.dialect);
};

const executeSqlite = async (client: ClientMembers, query: QueryModule, bound: BoundStatement): Promise<unknown[]> => {
  const { columns } = query;
  if (hasFunctionType(client.unsafe)) {
    return normalize(await inspectClient<BunProtocol>(client).unsafe(bound.text, bound.values), columns);
  }
  if (hasFunctionType(client.execute)) {
    const libsql = inspectClient<{ execute: (query: { sql: string; args: unknown[] }) => PromiseLike<{ rows: unknown[] }> }>(client);
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the native libSQL statement's key order.
    const result = await libsql.execute({ sql: bound.text, args: bound.values });
    return normalize(result.rows, columns);
  }
  if (isTurso(client)) {return runTurso(client, bound.text, bound.values, columns);}
  return executeSqliteStatements(client, bound, { columns, query });
};

const executeDialect = async (client: ClientMembers, query: QueryModule, bound: BoundStatement): Promise<unknown[]> => {
  switch (query.dialect) {
    case "postgres": {return executePostgres(client, query, bound);}
    case "mysql": {return executeMysql(client, query, bound);}
    case "duckdb": {return executeDuckdb(client, query, bound);}
    case "sqlite": {return executeSqlite(client, query, bound);}
    default: {throw unsupported(client, query.dialect);}
  }
};

const readAsyncCatalog = async (
  query: QueryModule,
  fresh: Fresh,
  run: (probe: QueryModule) => Promise<unknown[]>,
): Promise<unknown[] | undefined> => {
  try {
    return await run({ dialect: query.dialect, order: [], params: [], sql: fresh.query, text: fresh.query });
  } catch {
    // The caller's role can lack catalog access. It can still run the actual query.
    return undefined;
  }
};

const executeAsync = async function executeAsync(client: ClientMembers | null | undefined, query: QueryModule, params: ParamsInput): Promise<unknown[]> {
  if (matchesNullish(client) || (!hasObjectType(client) && !hasFunctionType(client))) {throw unsupported(client, query.dialect);}
  // A DuckDB connection has prepare() as SQLite's drivers do, and runs no other database's statement.
  if (query.dialect !== "duckdb" && isDuckdb(client)) {throw unsupported(client, query.dialect);}
  checkParams(query, params);
  // The catalog facts the statement relied on, read again through the same client.
  if (query.fresh && due(query)) {
    const { fresh } = query;
    const rows = await readAsyncCatalog(query, fresh, async (probe) => executeAsync(client, probe, {}));
    verifyFreshness(query, fresh, rows);
  }
  return executeDialect(client, query, statement(query, params));
};

/**
 * Runs the statement and returns its rows (an empty array for a statement that returns none).
 * On a synchronous SQLite client the rows come back at once and an error is thrown; on every
 * other client they come back as a promise, which rejects with the driver's own error.
 *
 * @param {ClientFor<D>} client - The native driver client, connection or transaction.
 * @param {QueryModule<D>} query - The module with the statement and its metadata.
 * @param {ParamsInput} params - The values keyed by parameter name or position.
 * @returns {unknown[] | Promise<unknown[]>} The decoded rows or a promise that resolves to them.
 */
export const execute = function execute<D extends Dialect>(
  client: ClientFor<D>,
  query: QueryModule<D>,
  params: ParamsInput = {},
): unknown[] | Promise<unknown[]> {
  const currentClient = underneath(inspectClient(client));
  if (query.dialect === "sqlite" && (isSyncSqlite(currentClient) || isDurableObjectSql(currentClient))) {return executeSyncSqlite(currentClient, query, params);}
  return executeAsync(currentClient, query, params);
};
