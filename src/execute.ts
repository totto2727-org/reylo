// Runtime execution over a caller-supplied client, typed structurally so that
// Reylo has no dependency (not even a type-only one) on any driver package.
// Each type is the smallest slice of the real driver that execution needs, and
// The query's dialect selects which clients are accepted at compile time. A
// Transaction, savepoint, reserved or checked-out connection has the same shape
// As the client it came from, so it is accepted wherever that client is.

import { bunRows, neonCallable, postgresJs, queryPostgres, slonik } from "./decode.ts";
import { mariadb, mysql2, planetscale } from "./decode-mysql.ts";
import { normalize, runDurableObject, runSyncSqlite, runTurso } from "./decode-sqlite.ts";
import { encodeDuckdb, isDuckdb, runDuckdb } from './decode-duckdb.ts';
import type { DriverValue, DuckdbClient } from './decode-duckdb.ts';
import { describe, hstoreText, ParameterError, postgresInterval, postgresYear, zoned } from './values.ts';
import type { Columns } from './values.ts';
import type { EngineType,JsonSchema } from "./engine-type.ts";
import { lexPlaceholders } from "./lex.ts";
import { withSqlcommenter } from "./sqlcommenter.ts";
import type { Checks } from "./checks.ts";
import type { Structured } from "./rows.ts";
import { differences, due, passed, staleError } from './fresh.ts';
import type { Fresh } from './fresh.ts';
import { hasFunctionType, hasObjectType, matchesBigInt, matchesBoolean, matchesNull, matchesNullish, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";

export type Dialect = "postgres" | "mysql" | "sqlite" | "duckdb";

/**
 * Pg's Pool, Client and PoolClient; PGlite and its transactions; Neon's Pool and Client;
 * pg-promise's database, tasks and transactions; @vercel/postgres: query(text, values) → { rows }
 * (pg-promise resolves to the rows themselves, and its types say any).
 */
export type PgQueryClient = {
  query(text: string, values?: DriverValue[]): PromiseLike<{ rows: unknown[] }>;
  /** Mariadb's query() resolves to any as well; its escapeId() tells it apart. */
  escapeId?: never;
};
/**
 * Neon's neon() function from 1.0: query(text, values) → rows. Its transaction() tells it from
 * mysql2/promise, whose query(text, values) resolves to a [rows, fields] array as well.
 */
export type NeonHttpClient = {
  query(text: string, values?: DriverValue[]): PromiseLike<Record<string, unknown>[]>;
  transaction(...args: DriverValue[]): unknown;
};
/** Postgres.js `sql`, its begin and savepoint transactions and reserved connections; Bun.sql, likewise: unsafe(text, params) → rows. */
export type UnsafeClient = {
  unsafe(text: string, params?: DriverValue[]): PromiseLike<unknown[]>;
};
/** Bun.sql on MySQL or SQLite; commitDistributed() tells it from postgres.js, which has unsafe() too. */
export type BunSqlClient = UnsafeClient & { commitDistributed(name: string): Promise<unknown> };
/** Neon's neon() function before 1.0, which is called with (text, params). */
export type CallableClient = (text: string, params?: DriverValue[]) => PromiseLike<unknown[] | { rows: unknown[] }>;
/** Slonik's pool, connections, transactions and savepoints, whose query() takes only its sql tag's queries. */
export type SlonikClient = { query(sql: DriverValue): PromiseLike<unknown>; maybeOneFirst(...args: DriverValue[]): unknown; anyFirst(...args: DriverValue[]): unknown };
/**
 * Mysql2/promise Pool, Connection and PoolConnection (→ [rows, fields]); PlanetScale's Connection,
 * Client and transaction from 1.x (→ { rows }). PlanetScale 2.0 binds no parameters, so its
 * execute(query, options) is not one of these.
 */
export type MysqlExecuteClient = {
  execute(text: string, values?: DriverValue[]): PromiseLike<[unknown, unknown] | { rows: unknown[]; statement: string }>;
};
/** Mysql2's callback Pool, Connection and PoolConnection, run through their promise() wrapper. */
export type Mysql2CallbackClient = { promise: () => MysqlExecuteClient };
/** Mariadb's Pool, Connection and PoolConnection: query(text, values) → rows, or an OK packet for a write. */
export type MariadbClient = {
  query(text: string, values?: DriverValue): Promise<unknown>;
  batch(text: string, values?: DriverValue): Promise<unknown>;
};
/** The same from mariadb's callback API (`mariadb/callback`): query(text, values, callback). */
export type MariadbCallbackClient = {
  query(text: string, values: DriverValue, callback: (error: Error | null, rows?: DriverValue) => void): void;
  batch(text: string, values: DriverValue, callback: (error: Error | null, result?: DriverValue) => void): void;
};
/**
 * Better-sqlite3, node:sqlite's DatabaseSync, bun:sqlite's Database and the Database of Turso's
 * `@tursodatabase/database/compat`, which answer at once: `runSync` takes them and returns the
 * result itself, so it works inside their `db.transaction(fn)`, whose function must not await.
 */
export type SyncSqliteClient = {
  prepare(sql: string): { all(...params: DriverValue[]): unknown[] };
};
/**
 * A SQLite-backed Durable Object's SQL storage, `ctx.storage.sql`: exec(sql, ...values) answers at
 * once with a cursor, so `runSync` takes it, inside `ctx.storage.transactionSync(fn)` too.
 */
export type DurableObjectSql = {
  exec(query: string, ...bindings: DriverValue[]): { toArray: () => unknown[] };
  readonly databaseSize: number;
};
/** A Durable Object's storage, `ctx.storage`, which `drizzle-orm/durable-sqlite` keeps: `run` takes its `sql`. */
export type DurableObjectStorage = Readonly<{ sql: DurableObjectSql }>;
/** Cloudflare D1's database and sessions: prepare(sql).bind(...values).all() → { results }. */
export type D1Client = {
  prepare(sql: string): { bind(...values: DriverValue[]): { all: () => Promise<{ results: unknown[] }> } };
};
/** @libsql/client's Client and Transaction: execute({ sql, args }) → { rows }. */
export type LibsqlClient = {
  execute(statement: { sql: string; args: DriverValue[] }): Promise<{ rows: unknown[] }>;
  /** Mariadb's execute() takes an object with sql and resolves to any; executeMultiple() tells libSQL apart. */
  executeMultiple(sql: string): Promise<unknown>;
};
/**
 * Turso's new engine, `@tursodatabase/database`: the Database `connect()` resolves to and the
 * Transaction `transactionAsync()` hands its callback, whose statements answer through a promise:
 * prepare(sql).all(...values) → rows. Its types say prepare() returns a promise of the statement
 * from 0.6, and the statement itself before; it returns the statement itself in every release.
 */
export type TursoClient = {
  prepare(sql: string): TursoStatement | PromiseLike<TursoStatement>;
  /** Postgres.js's transaction has a prepare(name) of any type too; exec() tells Turso's apart. */
  exec(sql: string): Promise<unknown>;
};
interface TursoStatement { all(...params: DriverValue[]): Promise<unknown[]> }
/** The sqlite3 package's callback Database: all(sql, params, callback). */
export type Sqlite3Client = {
  all(sql: string, params: DriverValue[], callback: (error: Error | null, rows: DriverValue[]) => void): unknown;
};
/** The sqlite package's promise Database: all(sql, params) → rows. */
export type SqlitePromiseClient = {
  all(sql: string, params?: DriverValue): Promise<unknown[]>;
  getDatabaseInstance: () => unknown;
};

/**
 * A Drizzle database over one of these clients (`drizzle(pool)`, whose `$client` is the pool):
 * `run` runs on the driver client underneath, so the values are what Reylo decodes on that driver.
 */
export type DrizzleDatabase<C> = Readonly<{ $client: C }>;
/**
 * A transaction or savepoint a Drizzle database hands out (`db.transaction(async (tx) => …)`),
 * which `run` runs on through the transaction's own connection. Each dialect's is known by what
 * only it has: `setTransaction()` on Postgres, `get()` and `all()` on SQLite, neither on MySQL.
 */
export type DrizzlePgTransaction = { rollback: () => never; setTransaction(config: DriverValue): Promise<void> };
export type DrizzleMysqlTransaction = { rollback: () => never; execute(query: DriverValue): unknown; setTransaction?: never; get?: never };
export type DrizzleSqliteTransaction = { rollback: () => never; get(query: DriverValue): unknown; all(query: DriverValue): unknown };
/** A transaction of a synchronous SQLite driver's Drizzle database, whose `all()` returns the rows themselves. */
export type DrizzleSyncSqliteTransaction = { rollback: () => never; get(query: DriverValue): unknown; all(query: DriverValue): unknown[] };
/** Every Postgres client `run` takes, or a transaction, savepoint or connection taken from one. */
export type PostgresClient = PgQueryClient | NeonHttpClient | UnsafeClient | CallableClient | SlonikClient | DrizzleDatabase<PgQueryClient | NeonHttpClient | UnsafeClient | CallableClient> | DrizzlePgTransaction;
/** Every MySQL client `run` takes, or a transaction or connection taken from one. */
export type MysqlClient = MysqlExecuteClient | Mysql2CallbackClient | MariadbClient | MariadbCallbackClient | BunSqlClient | DrizzleDatabase<MysqlExecuteClient | Mysql2CallbackClient | MariadbClient | BunSqlClient> | DrizzleMysqlTransaction;
/** Every SQLite client `run` takes, or a transaction taken from one. */
export type SqliteClient = SyncSqliteClient | DurableObjectSql | D1Client | LibsqlClient | TursoClient | Sqlite3Client | SqlitePromiseClient | BunSqlClient | DrizzleDatabase<SyncSqliteClient | DurableObjectStorage | D1Client | LibsqlClient | BunSqlClient> | DrizzleSqliteTransaction;

export type { DuckdbClient } from "./decode-duckdb.ts";

// Each dialect's clients are one named union, so a hover over `run` reads
// `run(client: PostgresClient, …)` rather than listing every client's shape.
export type ClientFor<D extends Dialect> = D extends "postgres" ? PostgresClient : D extends "mysql" ? MysqlClient : D extends "duckdb" ? DuckdbClient : SqliteClient;

/** The clients `runSync` takes: the synchronous SQLite drivers, and none for Postgres or MySQL. */
export type SyncClientFor<D extends Dialect> = D extends "sqlite" ? SyncSqliteClient | DurableObjectSql | DrizzleDatabase<SyncSqliteClient | DurableObjectStorage> | DrizzleSyncSqliteTransaction : never;

export type QueryModule<D extends Dialect = Dialect> = Readonly<{
  dialect: D;
  /** The statement as written, with Reylo's placeholders (`:id`) left in place: the query's `raw`. */
  sql: string;
  /** Parameter names in placeholder order, so an object of params binds positionally. */
  params: Readonly<string[]>;
  /** The statement as the engine compiled it for the database, when a build step ran: the query's `sql`. A query without it is compiled by `compile` below. */
  text?: string | undefined;
  /** The binding order for `text`: one name per placeholder of the rewritten statement. */
  order?: Readonly<string[]> | undefined;
  /** What the analysis found of each parameter, by name (every build step puts it in the module). */
  inputs?: Inputs | undefined;
  /** Each output column's name and kind (src/values.ts), in order: what the run time gives each value (every build step puts it in the module). */
  columns?: Columns | undefined;
  /** Each structured parameter in insert position, with the lists of `text` the run time writes again for the keys a call carries. */
  structured?: Readonly<Structured[]> | undefined;
  /** The catalog facts the statement relied on, checked before it runs (src/fresh.ts). */
  fresh?: Fresh | undefined;
  /** The `.sql` file the module was built from, relative to the project's root, for messages. */
  source?: string | undefined;
  /** Whether the statement Reylo sends ends with a sqlcommenter comment naming `source` (src/sqlcommenter.ts); `text`, the query's `sql`, leaves it out. */
  sqlcommenter?: boolean | undefined;
  /** The checks of a typed JSON, structured or cast parameter (src/checks.ts), which a build step passes where the statement has one. */
  checks?: Checks | undefined;
}>;

/**
 * Each parameter by name: `type` is the engine's type for it. The run time reads it where a
 * driver binds a value of one type wrong (an array to a SQL array on postgres.js and Bun.sql, to
 * JSON on pg); a query without it, defined by hand or built before 2026-10-12, binds every value
 * as it is. A typed JSON parameter (wiki/typed-json-params.md) carries its schema beside it, and
 * a parameter cast with `::` on MySQL or SQLite the type as written (src/rows.ts, `checkCast`).
 * `nullable` is false where the statement takes no null for the parameter, which the run time
 * then refuses, given or left out, except that a JSON parameter's null there is JSON's null; a
 * query defined by hand without it binds what it is given.
 */
export type Inputs = Readonly<Record<string, Readonly<{ type: EngineType; schema?: JsonSchema; cast?: string; nullable?: boolean }>>>;

type ClientMembers = Record<string, unknown>;
type DriverRows = PromiseLike<unknown[]>;
interface BunProtocol { unsafe: (text: string, params: unknown[]) => DriverRows }

/**
 * The parameters: an object keyed by name, or by number for positional placeholders (`$1` and
 * `?` give `{ 1: ..., 2: ... }`, and `params` is `["1", "2"]`). An array is refused, since
 * 2026-10-20 (wiki/design.md §9).
 */
export type ParamsInput = Record<string, unknown>;

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

const asByteaHex = function asByteaHex(v: unknown) {
  if (!(v instanceof Uint8Array)) {return v;}
  let hex = String.raw`\x`;
  Iterator.from(v).forEach((byte) => {hex += (byte < HEX_RADIX ? "0" : "") + byte.toString(HEX_RADIX);});
  return hex;
};

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

/** `text` as Reylo sends it: with the comment naming the query's file, where the module asks for one (src/sqlcommenter.ts). */
export function sentText(query: QueryModule, text: string): string {
  return query.sqlcommenter && query.source ? withSqlcommenter(text, query.source) : text;
}

/** The checks a parameter needs (src/checks.ts): every build step passes them where its statement has such a parameter. */
const checksFor = function checksFor(query: QueryModule, name: string): Checks {
  if (query.checks) {return query.checks;}
  throw new ParameterError(`Parameter "${name}" is a typed JSON, structured or cast parameter, which the run time checks with Reylo's checks; a query defined by hand passes them: defineQuery({ …, checks }) with checks from "@totto2727/reylo".`);
};

/** Where an array, or an array inside it (a multidimensional one), holds null or undefined: `[2]`, `[1][0]`. */
const nullElement = function nullElement(array: Readonly<unknown[]>, path = ""): string | undefined {
  for (let i = 0; i < array.length; i++) {
    const e = array[i];
    if (matchesNullish(e)) {return `${path}[${i}]`;}
    if (Array.isArray(e)) {
      const inner = nullElement(e, `${path}[${i}]`);
      if (!matchesUndefined(inner)) {return inner;}
    }
  }
  return undefined;
};

/** Whether a parameter the statement takes no null for is declared with a type that takes no null: for a JSON one, whether the schema its type carries refuses JSON's null too. */
const refusesNull = function refusesNull(query: QueryModule, type: EngineType | undefined): boolean {
  if (matchesUndefined(type) || type.kind === "unknown") {return false;}
  if (type.kind !== "json") {return true;}
  return !matchesUndefined(type.schema) && !matchesUndefined(query.checks) && !matchesUndefined(query.checks.validate(type.schema, null));
};

/** A parameter the statement takes no null for, given null or left out. */
const refuseNull = function refuseNull(name: string, v: unknown): never {
  throw new ParameterError(`Parameter "${name}" ${matchesUndefined(v) ? "is missing" : "is null"}, and the statement takes no null for it: pass a value.`);
};

const value = function value(params: Record<string, unknown>, name: string) {
  const v = params[name];
  return matchesUndefined(v) ? null : v;
};

// A binary parameter is typed Uint8Array, and every driver binds one as it is (pg-promise too,
// Since it gets { text, values }) but two (lab/driver-matrix, S1c). mariadb writes any value
// That is not a Buffer as JSON, so a plain Uint8Array (TextEncoder's, getRandomValues') arrived
// As the text {"0":1,"1":2,"2":255}: it gets a Buffer over the same memory, where a Buffer
// Exists (not in every Worker). Neon's neon() before 0.10 sends a Buffer as JSON as well, so it
// Gets Postgres's hex form, `\x0102ff`, which 0.10 and later send for a Buffer themselves.
const asBuffer = function asBuffer(v: unknown) {
  // Named structurally, so that a project without Node's types can type-check the module.
  const NodeBuffer = (globalThis as { Buffer?: { isBuffer(v: unknown): boolean; from(buffer: ArrayBufferLike, offset: number, length: number): Uint8Array } }).Buffer;
  return v instanceof Uint8Array && !matchesUndefined(NodeBuffer) && !NodeBuffer.isBuffer(v) ? NodeBuffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
};

const isJson = (kind: EngineType["kind"] | undefined) => kind === "json" || kind === "object" || kind === "list" || kind === "rows";

// A JSON parameter's value is a JavaScript value, which reaches the database as its JSON text
// (JSON.stringify), so a string is a JSON string on every driver; null is SQL NULL where the
// Statement takes SQL NULL for the parameter, and JSON's null elsewhere (`JSON_NULL`). Each driver
// Left to itself did something else (wiki/driver-decoding.md, 2026-10-12): pg wrote an array as
// An array literal and a string as raw JSON text, mariadb expanded an array into a list, the
// SQLite drivers refused an object, and mysql2 bound 5 as 5.0.
const isJsonValue = function isJsonValue(query: QueryModule, name: string, v: unknown): boolean {
  return !matchesNullish(v) && isJson(query.inputs?.[name]?.type.kind);
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

/** A JSON parameter's value as JSON: `JSON_NULL` as null. */
const jsonValue = (v: unknown) => (v === JSON_NULL ? null : v);

/** A JSON parameter's value as the JSON text a driver binds. */
const jsonText = (v: unknown): string => JSON.stringify(jsonValue(v));

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

const checkTime = function checkTime(type: EngineType | undefined, name: string, v: unknown): void {
  if (matchesUndefined(type) || matchesNullish(v)) {return;}
  if (type.kind === "array") {
    if (Array.isArray(v)) {Iterator.from(v).forEach((e) => {checkTime(Array.isArray(e) ? type : type.of, name, e);});}
    return;
  }
  if (type.kind !== "scalar") {return;}
  if (type.name === "timestamptz") {
    if (v instanceof Date) {
      throw new ParameterError(`Parameter "${name}" is a timestamptz, which takes the instant as a string that names its zone, as \`.run()\` returns one, not a Date: pass date.toISOString() ("2026-10-12T19:06:48.282Z").`);
    }
    if (matchesString(v) && !zoned.test(v.trim())) {
      throw new ParameterError(`Parameter "${name}" is a timestamptz, an instant, so a string for it names its zone ("2026-10-12T19:06:48.282Z", "2026-10-12 19:06:48+09", "2026-10-12 19:06:48 America/Los_Angeles"); got ${JSON.stringify(v)}, which the server would read in the session's time zone.`);
    }
  } else if (v instanceof Date && type.name.split("|").every((part) => part === "timestamp" || part === "date")) {
    throw new ParameterError(`Parameter "${name}" is a ${type.name === "date" ? "date" : "timestamp"} without a time zone, so it takes the wall-clock text ("2026-10-12 19:06:48.282", "2026-10-12"), not a Date: drivers write a Date's time in different zones (the app's, the server's or UTC).`);
  }
};

// A binary parameter takes a Uint8Array (a Buffer is one), as `.run()` returns binary data and
// As a structured parameter's binary member does (src/rows.ts). Anything else would reach the
// Driver as it is, and a string means something different on each database: Postgres reads it
// As bytea's hex or escape text, MySQL stores the bytes of its UTF-8, and SQLite stores it as
// TEXT, which comes back a string. So base64 text was stored as its own letters.
const checkBinary = function checkBinary(type: EngineType | undefined, name: string, v: unknown): void {
  if (matchesUndefined(type) || matchesNullish(v)) {return;}
  if (type.kind === "array") {
    if (Array.isArray(v)) {Iterator.from(v).forEach((e) => {checkBinary(Array.isArray(e) ? type : type.of, name, e);});}
    return;
  }
  if (type.kind !== "scalar" || (type.name !== "bytea" && type.name !== "blob") || v instanceof Uint8Array) {return;}
  throw new ParameterError(`Parameter "${name}" is binary data, so it takes a Uint8Array (a Buffer is one), as \`.run()\` returns one; got ${describe(v)}. ${v instanceof ArrayBuffer ? "Wrap an ArrayBuffer in one: new Uint8Array(buffer)." : "Decode base64 or hex text into one first."}`);
};

/** Whether `type` is one of pgvector's dense vectors, which `.run()` returns as an array of numbers. */
const isVector = (type: EngineType): type is EngineType & { kind: "scalar" } => type.kind === "scalar" && (type.name === "vector" || type.name === "halfvec");

/** A vector's floats as the text a VECTOR's `to_vector` and pgvector's input read; JSON's, which would write NaN and ±Infinity as null, so those are refused. */
const vectorText = function vectorText(v: Readonly<unknown[]>, name: string, what: string): string {
  v.forEach((e, index) => {
    if (!matchesNumber(e) || !Number.isFinite(e)) {
      throw new ParameterError(`Parameter "${name}" is ${what}, an array of finite numbers, and the element at [${index}] is ${matchesString(e) ? JSON.stringify(e) : (matchesNumber(e) ? e : typeof e)}.`);
    }
  });
  return JSON.stringify(v);
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
const encode = function encode(type: EngineType | undefined, v: unknown, dialect: Dialect, name: string): unknown {
  if (matchesUndefined(type) || matchesNullish(v)) {return v;}
  if (dialect === "duckdb") {return encodeDuckdb(type, v, name);}
  if (dialect === "sqlite") {
    if (matchesBoolean(v)) {return v ? SQLITE_TRUE_INTEGER : SQLITE_FALSE_INTEGER;}
    return v;
  }
  if (dialect === "mysql") {return type.kind === "array" && Array.isArray(v) ? vectorText(v, name, "a VECTOR") : v;}
  if (type.kind === "array") {return Array.isArray(v) ? v.map((e) => encode(Array.isArray(e) && !isVector(type.of) ? type : type.of, e, dialect, name)) : v;}
  if (isVector(type) && Array.isArray(v)) {
    if (!v.length) {throw new ParameterError(`Parameter "${name}" is a pgvector ${type.name}, which has one dimension at least; got an empty array.`);}
    return vectorText(v, name, `a pgvector ${type.name}`);
  }
  if (type.kind === "scalar" && type.name === "hstore" && hasObjectType(v)) {return hstoreText(v, (message) => {
    throw new ParameterError(`Parameter "${name}" ${message}`);
  });}
  if (!matchesString(v)) {return v;}
  if (isTime(type)) {return postgresYear(v);}
  return type.kind === "scalar" && type.name === "interval" ? postgresInterval(v) : v;
};

// Sqlite3 6.0.1 binds a BigInt as NULL, with no error (`select cast(? as text)` with
// 9007199254740993n gave null), and a Durable Object's exec() refuses one, where every other
// SQLite driver binds it exactly. A BigInt a number holds exactly goes as that number. A larger
// One goes as its digits to a parameter of a BIGINT column (the engine's int8), whose INTEGER
// Affinity reads the text as that integer in an insert and a comparison alike, and is refused
// Anywhere else, where the text would stay text.
const numberOrDigits = function numberOrDigits(v: unknown, type: EngineType | undefined, driver: "sqlite3" | "durable-object"): unknown {
  if (!matchesBigInt(v)) {return v;}
  if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {return Number(v);}
  if (type?.kind === "scalar" && type.name === "int8") {return String(v);}
  const digits = "pass it as a string of digits, which SQLite stores as that integer in an INTEGER column";
  if (driver === "durable-object") {throw new ParameterError(`A Durable Object's SQL storage binds no BigInt, and ${v} is past 2^53 - 1, where a number stops being exact: ${digits}.`);}
  throw new ParameterError(`sqlite3 binds a BigInt as NULL, and ${v} is past 2^53 - 1, where a number stops being exact: ${digits}, or run the statement on better-sqlite3, node:sqlite or libSQL, which bind a BigInt.`);
};

// A Durable Object's exec() refuses a BigInt ("Cannot convert a BigInt value to a number").
const durableObjectValues = function durableObjectValues(query: QueryModule, names: Readonly<string[]>, values: unknown[]): unknown[] {
  return values.map((currentValue, index) => numberOrDigits(currentValue, query.inputs?.[names[index]!]?.type, "durable-object"));
};

const CLOCK_FIELD_WIDTH = 2;
const YEAR_FIELD_WIDTH = 4;
const MILLISECOND_FIELD_WIDTH = 3;
const FIRST_AD_YEAR = 1;
const FIRST_CALENDAR_MONTH = 1;
const MINUTES_PER_HOUR = 60;
const ZERO_ZONE_OFFSET = 0;

/** Pg's `dateToString`: the local date and time to the millisecond, then the offset; BC for a year before 1. */
const dateText = function dateText(date: Date): string {
  const pad = (field: number, width = CLOCK_FIELD_WIDTH): string => String(field).padStart(width, "0");
  const year = date.getFullYear();
  const offset = -date.getTimezoneOffset();
  const absoluteOffset = Math.abs(offset);
  const beforeEra = year < FIRST_AD_YEAR;
  const yearText = pad(beforeEra ? FIRST_AD_YEAR - year : year, YEAR_FIELD_WIDTH);
  const calendarDay = `${pad(date.getMonth() + FIRST_CALENDAR_MONTH)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), MILLISECOND_FIELD_WIDTH)}`;
  const zone = `${offset < ZERO_ZONE_OFFSET ? "-" : "+"}${pad(Math.floor(absoluteOffset / MINUTES_PER_HOUR))}:${pad(absoluteOffset % MINUTES_PER_HOUR)}`;
  return `${yearText}-${calendarDay}T${time}${zone}${beforeEra ? " BC" : ""}`;
};

/**
 * A Postgres array literal, written as pg writes one (`arrayString` in pg/lib/utils.js): a nested
 * array in braces, null and undefined as NULL, binary data as `\\x` and its hex, and every other
 * element quoted, with `"` and `\` escaped: a Date as its local time and offset, an object as
 * its JSON, anything else as its string. The elements are separated by `delim`, the element type's
 * delimiter: the server reads `{"a","b"}` as one element of a `geometry[]`, whose delimiter is `:`.
 */
export function arrayLiteral(array: Readonly<unknown[]>, delim = ","): string {
  let out = "{";
  for (let i = 0; i < array.length; i++) {
    const v = array[i];
    if (i) {out += delim;}
    if (matchesNullish(v)) {out += "NULL";}
    else if (Array.isArray(v)) {out += arrayLiteral(v, delim);}
    else if (ArrayBuffer.isView(v)) {out += `\\${  asByteaHex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}`;}
    else {out += `"${(v instanceof Date ? dateText(v) : (hasObjectType(v) ? JSON.stringify(v) : String(v))).replaceAll(/[\\"]/gu, String.raw`\$&`)}"`;}
  }
  return `${out  }}`;
}

// A value as Slonik's sql tag takes it, which is a string, a number, a boolean, a BigInt or null:
// The rest as pg would write them, binary data as `\x` and its hex, an array as its literal, a
// Date as its instant, and an object as its JSON. An omitted parameter binds NULL, as on pg.
const slonikParam = function (v: unknown): unknown {
  if (matchesUndefined(v) || matchesNull(v)) {return null;}
  if (v instanceof Uint8Array) {return asByteaHex(v);}
  if (Array.isArray(v)) {return arrayLiteral(v);}
  if (v instanceof Date) {return v.toISOString();}
  return hasObjectType(v) ? JSON.stringify(v) : v;
};

/** A bound value as the text Postgres's input function reads, as `.run()` sends it through pg. */
const postgresText = function postgresText(query: QueryModule, name: string, v: unknown): string | null {
  if (matchesNullish(v)) {return null;}
  const t = query.inputs?.[name]?.type;
  if (Array.isArray(v) && t?.kind === "array") {return arrayLiteral(isJson(t.of.kind) ? v.map((e) => (matchesNullish(e) ? e : JSON.stringify(e))) : v, t.delimiter);}
  if (isJsonValue(query, name, v)) {return jsonText(v);}
  if (Array.isArray(v)) {return arrayLiteral(v);}
  if (v instanceof Uint8Array) {return asByteaHex(v) as string;}
  if (matchesBoolean(v)) {return v ? "t" : "f";}
  if (v instanceof Date) {return dateText(v);}
  if (hasObjectType(v)) {return JSON.stringify(v);}
  return String(v);
};

const MISSING_PARAMETER = -1;
const FIRST_NUMBERED_PARAMETER = 1;

const indexOf = function indexOf(query: QueryModule, p: { name: string; start: number; end: number }): number {
  const index = query.params.indexOf(p.name);
  // A hand-built query whose `params` misses a placeholder would bind `$0`.
  if (index === MISSING_PARAMETER) {throw new Error(`The statement's placeholder ${query.sql.slice(p.start, p.end)} is parameter "${p.name}", which the query's params (${JSON.stringify(query.params)}) do not list.`);}
  return index;
};

/**
 * The statement as Reylo sends it to the database, and the parameter each placeholder binds: the
 * engine's compiled text where a build step wrote one into the module. Without it (a query
 * defined by hand) the run time lexes the placeholders itself (`lex.ts`); the engine's lexer is
 * the authoritative one, and the two agree on every statement the fallback is meant for.
 * Postgres numbers each distinct parameter once; MySQL has only `?`, and better-sqlite3 reads
 * SQLite's `?NNN` as a named parameter, so both get one `?` per placeholder and a repeated name is
 * repeated in the binding order.
 */
export function compile(query: QueryModule): { text: string; order: Readonly<string[]> } {
  if (query.text && query.order) {return { text: query.text, order: query.order };}
  const { placeholders } = lexPlaceholders(query.sql, query.dialect);
  // Postgres and DuckDB number each distinct parameter once.
  const numbered = query.dialect === "postgres" || query.dialect === "duckdb";
  let text = "";
  let last = 0;
  const order: string[] = [];
  Iterator.from(placeholders).forEach((p) => {
    const index = indexOf(query, p);
    text += query.sql.slice(last, p.start) + (numbered ? `$${index + FIRST_NUMBERED_PARAMETER}` : "?");
    order.push(p.name);
    last = p.end;
  });
  return { text: text + query.sql.slice(last), order: numbered ? query.params : order };
}

// The rows are bound positionally in every dialect. A value left out binds NULL, as pg,
// PGlite, better-sqlite3 and Bun.sql already do; postgres.js, mysql2, node:sqlite and libSQL
// Would reject it instead.
const statement = function statement(query: QueryModule, params: ParamsInput) {
  // The build step already compiled the statement; only the values need ordering.
  const compiled = compile(query);
  const bound: { text: string; values: unknown[]; names: Readonly<string[]> } = { text: compiled.text, values: compiled.order.map((name) => value(params, name)), names: compiled.order };
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
      let v = params[name];
      const { cloneJson, validate, withDefaults } = checksFor(query, name);
      if (matchesUndefined(v) && !matchesNull(schema) && hasObjectType(schema) && "default" in schema) {v = cloneJson(schema.default);}
      if (!matchesUndefined(v) && !matchesNull(v)) {
        v = withDefaults(schema, v);
        const failure = validate(schema, v);
        if (failure) {throw new ParameterError(`Parameter "${name}"${failure.path ? ` at ${failure.path}` : ""} ${failure.message}.`);}
      } else if (input?.nullable === false) {
        if (matchesUndefined(v) || validate(schema, null)) {refuseNull(name, v);}
        v = JSON_NULL;
      }
      bound.values[index] = matchesUndefined(v) ? null : v;
      return;
    }
    // A structured parameter is checked against its column list and written as the JSON the
    // Statement reads; in an insert, its lists name only the keys the call carries. It refuses
    // Null itself, saying what to pass.
    if (type?.kind === "rows") {
      const structured = query.structured?.find((s) => s.name === name);
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
    bound.values[index] = jsonNull ? JSON_NULL : encode(type, bound.values[index], query.dialect, name);
  });
  // Every MySQL and SQLite driver binds JSON text as text, which the database reads as JSON (a
  // Structured parameter's is written already).
  if (query.dialect !== "postgres") {bound.values = bound.values.map((currentValue, index) => (isJsonValue(query, bound.names[index]!, currentValue) && query.inputs?.[bound.names[index]!]?.type.kind !== "rows" ? jsonText(currentValue) : currentValue));}
  // The comment naming the file goes on last, after a structured parameter's lists are written.
  bound.text = sentText(query, bound.text);
  return bound;
};

const executeSyncSqlite = function executeSyncSqlite(client: ClientMembers, query: QueryModule, params: ParamsInput): unknown[] | Promise<unknown[]> {
  checkParams(query, params);
  if (query.fresh && due(query)) {
    let rows: unknown[] | undefined;
    try {
      rows = isDurableObjectSql(client)
        ? inspectClient<{ exec: (sql: string) => { toArray: () => unknown[] } }>(client).exec(query.fresh.query).toArray()
        : inspectClient<{ prepare: (sql: string) => { all: () => unknown[] } }>(client).prepare(query.fresh.query).all();
    } catch {}
    const lines = (rows && differences(query.fresh, rows, query.dialect)) ?? [];
    if (lines.length) {throw staleError(query.source, lines);}
    passed(query);
  }
  const { text, values, names } = statement(query, params);
  if (isDurableObjectSql(client)) {return runDurableObject(client, text, durableObjectValues(query, names, values), query.columns);}
  return runSyncSqlite(client, text, values, query.columns);
};

/** The synchronous path alone, for `runSync`: any other client is refused before anything runs. */
export const executeSync = function executeSync<D extends Dialect>(client: SyncClientFor<D>, query: QueryModule<D>, params: ParamsInput = {}): unknown[] {
  const currentClient = underneath(inspectClient(client));
  const refuse = (why: string) => new TypeError(`runSync takes a synchronous SQLite client (better-sqlite3, node:sqlite, bun:sqlite, the Database of @tursodatabase/database/compat or a Durable Object's ctx.storage.sql); ${why}. run takes every client.`);
  if (query.dialect !== "sqlite") {throw refuse(`a ${query.dialect} statement has none`);}
  if (!isSyncSqlite(currentClient) && !isDurableObjectSql(currentClient)) {throw refuse("this client answers through a promise");}
  const rows = executeSyncSqlite(currentClient, query, params);
  if (Array.isArray(rows)) {return rows;}
  rows.catch(() => {});
  throw refuse("this client's statement answered with a promise");
};

/**
 * The statement and its values in the database's raw form, which a Standard Query's `encode`
 * returns (src/standard-query.ts), bound as `.run()` binds them, its checks included: on Postgres
 * each value's text, which a driver binds with no declared type, so the server reads it as the
 * parameter's type; on MySQL and SQLite each value as a driver binds it.
 */
export const rawStatement = function rawStatement(query: QueryModule, params: unknown): { text: string; values: unknown[] } {
  checkParams(query, params);
  const { text, values, names } = statement(query, params);
  if (query.dialect !== "postgres") {return { text, values };}
  return { text, values: values.map((currentValue, index) => postgresText(query, names[index]!, currentValue)) };
};

const accepted: Record<Dialect, string> = {
  postgres: "query(text, values) as on pg, PGlite, Neon and pg-promise; unsafe(text, values) as on postgres.js and Bun.sql; Neon's neon() function; a Slonik pool, connection or transaction; or a Drizzle database over one of them",
  mysql: "execute(text, values) as on mysql2 and PlanetScale; query(text, values) as on mariadb's pool or connection, from its promise or callback API; unsafe(text, values) as on Bun.sql; a mysql2 callback pool or connection; or a Drizzle database over one of them",
  sqlite: "prepare(sql) as on better-sqlite3, node:sqlite, bun:sqlite, Turso's @tursodatabase/database and Cloudflare D1; exec(sql, ...values) as on a Durable Object's ctx.storage.sql; execute({ sql, args }) as on @libsql/client; all(sql, params) as on sqlite3 and sqlite; unsafe(text, values) as on Bun.sql; or a Drizzle database over one of them",
  duckdb: "runAndReadAll(sql, values) as on @duckdb/node-api's DuckDBConnection",
};

const MAX_DRIVER_METHODS_IN_DIAGNOSTIC = 12;

const unsupported = function unsupported(c: unknown, dialect: Dialect): TypeError {
  let seen: string;
  if (matchesNull(c) || (!hasObjectType(c) && !hasFunctionType(c))) {seen = String(c);}
  else {
    const names = new Set<string>();
    for (let o: object | null = c; o && o !== Object.prototype && o !== Function.prototype; o = Reflect.getPrototypeOf(o)) {
      Iterator.from(Object.getOwnPropertyNames(o)).forEach((key) => {
        const d = Object.getOwnPropertyDescriptor(o, key);
        if (key !== "constructor" && hasFunctionType(d?.value)) {names.add(key);}
      });
    }
    seen = names.size ? `an object with ${Iterator.from(names).take(MAX_DRIVER_METHODS_IN_DIAGNOSTIC).toArray().join(", ")}${names.size > MAX_DRIVER_METHODS_IN_DIAGNOSTIC ? ", ..." : ""}` : "an object with no methods";
  }
  // Node:sqlite's tag store keeps its database on db. Kysely and Prisma decode every value of a
  // Raw query themselves, by their own rules or the driver's parsers, before it returns.
  // Neither hands out a transaction's connection.
  const o = matchesNullish(c) ? undefined : inspectClient<{ db?: { prepare?: unknown } }>(c);
  const inTx = " and does not hand out its transaction's connection: take the transaction from the driver's client instead.";
  const hint =
    dialect !== "duckdb" && isDuckdb(inspectClient(c))
      ? ` It is a DuckDB connection, and the statement is typed for ${dialect}: set the project's URL to the DuckDB database (duckdb:./app.duckdb).`
      : hasFunctionType(o?.db?.prepare)
      ? " A tag store is not a client: pass its database, store.db."
      : hasFunctionType(o?.selectFrom) && hasFunctionType(o.executeQuery)
        ? ` Kysely decodes the values of its queries itself${o.isTransaction === true ? inTx : ": pass the pool or database its dialect was made with."}`
        : hasFunctionType(o?.$queryRawUnsafe)
          ? ` Prisma decodes the values of its queries itself${hasFunctionType(o.$transaction) ? ": pass a client of your database's driver, such as the pool its driver adapter was made with." : inTx}`
          : "";
  return new TypeError(`reylo cannot run a ${dialect} statement on ${seen}. It takes a client with ${accepted[dialect]}.${hint}`);
};

const executeAsync = async function executeAsync(client: ClientMembers | null | undefined, query: QueryModule, params: ParamsInput): Promise<unknown[]> {
  if (matchesNullish(client) || (!hasObjectType(client) && !hasFunctionType(client))) {throw unsupported(client, query.dialect);}
  // A DuckDB connection has prepare() as SQLite's drivers do, and runs no other database's statement.
  if (query.dialect !== "duckdb" && isDuckdb(client)) {throw unsupported(client, query.dialect);}
  checkParams(query, params);
  // The catalog facts the statement relied on, read again through the same client.
  if (query.fresh && due(query)) {
    const {fresh} = query;
    let rows: unknown[] | undefined;
    try {
      rows = await executeAsync(client, { dialect: query.dialect, sql: fresh.query, params: [], text: fresh.query, order: [] }, {});
    } catch {}
    const lines = (rows && differences(fresh, rows, query.dialect)) ?? [];
    if (lines.length) {throw staleError(query.source, lines);}
    passed(query);
  }
  const { text, values, names } = statement(query, params);
  const type = (i: number) => query.inputs?.[names[i]!]?.type;
  const isJsonParam = (v: unknown, i: number): boolean => isJsonValue(query, names[i]!, v);
  switch (query.dialect) {
    case "postgres": {
      // An array for a SQL array parameter goes as its literal text, which the server reads as
      // The parameter's type, written as pg writes it: Bun.sql binds no JavaScript array
      // (`any($1)` failed with "insufficient data left in message"), postgres.js types an
      // Array by its first element ("cannot cast type boolean to boolean[]" for `$1::bool[]`),
      // And the copy of pg inside Neon's Pool and Client threw on a Uint8Array element and
      // Left the connection out of step. Each element of a `jsonb[]` is a JSON value.
      const bound = values.map((currentValue, index) => {
        const t = type(index);
        return Array.isArray(currentValue) && t?.kind === "array" ? arrayLiteral(isJson(t.of.kind) ? currentValue.map((e) => (matchesNullish(e) ? e : JSON.stringify(e))) : currentValue, t.delimiter) : currentValue;
      });
      // A JSON parameter goes to pg's family, PGlite and Neon as its JSON text, and to postgres.js
      // As its JSON text declared `unknown` (below). Bun.sql serializes a value for a JSON
      // Parameter itself, so JSON text would be stored as a JSON string, and it types a boolean,
      // A number or an array of either by its JavaScript type ("cannot cast type boolean to
      // Jsonb"): it gets an object whose toJSON() returns the value, which it binds as JSON and
      // Serializes to exactly its JSON text. So does an unsafe() client without typed().
      const json = () => bound.map((v, index) => (isJsonParam(v, index) ? jsonText(v) : v));
      // Slonik before every other query(): its query() takes only its sql tag's queries.
      if (isSlonik(client)) {return slonik(client, text, json().map(slonikParam), query.columns);}
      // Query() before unsafe(): Neon's neon() has both, and its unsafe() builds a fragment
      // For a template instead of running anything. Reylo decodes every value itself (decode.ts).
      if (hasFunctionType(client.query)) {return queryPostgres(client, text, json(), query.columns);}
      if (hasFunctionType(client.unsafe)) {
        // Postgres.js reads a string for a date or time parameter through `new Date(x)` and binds
        // Its toISOString(), so a timestamp's wall-clock time moved by the app's offset, and
        // `infinity` or a zone name failed with "Invalid time value". Declared `unknown` (705), it
        // Is sent as the text, which the server reads as the parameter's type, as it would an
        // Undeclared one. Bun.sql (commitDistributed()) sends the text and has no typed().
        // A JSON parameter goes to postgres.js as its JSON text declared `unknown` too: its own
        // Serializer would write a value as JSON, but a client Drizzle wraps has that serializer
        // Replaced by one that passes the value through (drizzle-orm/postgres-js), and a
        // Transaction shows neither. Bun.sql serializes the value itself.
        const bun = hasFunctionType(client.commitDistributed);
        const asText = hasFunctionType(client.typed) && !bun;
        const unknownPostgresOid = 705;
        const postgres = inspectClient<{ typed: (value: unknown, oid: number) => unknown }>(client);
        const mapped = bound.map((v, index) => (isJsonParam(v, index) ? (asText ? postgres.typed(jsonText(v), unknownPostgresOid) : { toJSON: () => jsonValue(v) }) : (asText && matchesString(v) && isTime(type(index)) ? postgres.typed(v, unknownPostgresOid) : v)));
        return bun ? bunRows(await inspectClient<BunProtocol>(client).unsafe(text, mapped), query.columns) : postgresJs(client, text, mapped, query.columns);
      }
      if (hasFunctionType(client)) {return neonCallable(client, text, json().map(asByteaHex), query.columns);}
      break;
    }
    case "mysql": {
      if (hasFunctionType(client.unsafe)) {return bunRows(await inspectClient<BunProtocol>(client).unsafe(text, values), query.columns);}
      // Mariadb, checked before execute() because it has one too (returning rows, not a pair).
      // Its callback API (mariadb/callback) answers through the callback and returns a command
      // Object; its promise API returns a promise and ignores the callback.
      if (hasFunctionType(client.batch) && hasFunctionType(client.query)) {return mariadb(client, text, values.map(asBuffer), query.columns);}
      // Mysql2's callback API: the promise() wrapper runs on the same connection.
      const mysqlClient = hasFunctionType(client.promise)
        ? inspectClient<{ promise: () => ClientMembers }>(client).promise()
        : client;
      if (hasFunctionType(mysqlClient.execute)) {
        // Mysql2 has query() beside execute(); PlanetScale's Connection, Client and transaction do not.
        return hasFunctionType(mysqlClient.query) ? mysql2(mysqlClient, text, values, query.columns) : planetscale(mysqlClient, text, values, query.columns);
      }
      break;
    }
    case "duckdb": {
      // @duckdb/node-api's DuckDBConnection: each value given its kind by the result's own types (decode-duckdb.ts).
      if (isDuckdb(client)) {return runDuckdb(inspectClient<DuckdbClient>(client), text, values, names.map((currentName, index) => type(index)), query.columns);}
      break;
    }
    case "sqlite": {
      // The driver's rows, each value given its kind (decode-sqlite.ts).
      const {columns} = query;
      if (hasFunctionType(client.unsafe)) {return normalize(await inspectClient<BunProtocol>(client).unsafe(text, values), columns);}
      if (hasFunctionType(client.execute)) {
        const libsql = inspectClient<{ execute: (query: { sql: string; args: unknown[] }) => PromiseLike<{ rows: unknown[] }> }>(client);
        const result = await libsql.execute({ sql: text, args: values });
        return normalize(result.rows, columns);
      }
      if (isTurso(client)) {return runTurso(client, text, values, columns);}
      // The sqlite package wraps sqlite3, and sqlite3 binds a BigInt as NULL.
      if (hasFunctionType(client.getDatabaseInstance)) {
        const sqlite = inspectClient<{ all: (text: string, values: unknown[]) => DriverRows }>(client);
        return normalize(await sqlite.all(text, values.map((currentValue, index) => numberOrDigits(currentValue, type(index), "sqlite3"))), columns);
      }
      if (hasFunctionType(client.all) && hasFunctionType(client.exec)) {
        const bound = values.map((currentValue, index) => numberOrDigits(currentValue, type(index), "sqlite3"));
        type Callback = (error: Error | null, rows: unknown[]) => void;
        const sqlite = inspectClient<{ all: (text: string, values: unknown[], done: Callback) => void }>(client);
        return normalize(
          await new Promise<unknown[]>((resolve, reject) => {
            sqlite.all(text, bound, (error, rows) => {
              const failed = Boolean(error);
              if (!failed) {resolve(rows);}
              else {reject(error);}
            });
          }),
          columns,
        );
      }
      if (hasFunctionType(client.prepare)) {
        const prepared = inspectClient<{ prepare: (text: string) => ClientMembers }>(client).prepare(text);
        if (hasFunctionType(prepared.first)) {
          const d1 = inspectClient<{ bind: (...values: unknown[]) => { all: () => PromiseLike<{ results: unknown[] }> } }>(prepared);
          const bound = d1.bind(...values);
          const result = await bound.all();
          return normalize(result.results, columns, { d1: true });
        }
        const statement = inspectClient<{ all: (...values: unknown[]) => DriverRows }>(prepared);
        return normalize(await statement.all(...values), columns);
      }
      break;
    }
  }
  throw unsupported(client, query.dialect);
};

/**
 * Runs the statement and returns its rows (an empty array for a statement that returns none).
 * On a synchronous SQLite client the rows come back at once and an error is thrown; on every
 * other client they come back as a promise, which rejects with the driver's own error.
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
