// Runtime execution over a caller-supplied client, typed structurally so that
// Reylo has no dependency (not even a type-only one) on any driver package.
// Each type is the smallest slice of the real driver that execution needs, and
// The query's dialect selects which clients are accepted at compile time. A
// Transaction, savepoint, reserved or checked-out connection has the same shape
// As the client it came from, so it is accepted wherever that client is.

import type { Checks } from "./checks.ts";
import type { DriverValue, DuckdbClient } from "./decode-duckdb.ts";
import type { EngineType, JsonSchema } from "./engine-type.ts";
import type { Fresh } from "./fresh.ts";
import type { Structured } from "./rows.ts";
import type { Columns } from "./values.ts";

export type Dialect = "postgres" | "mysql" | "sqlite" | "duckdb";

// oxlint-disable-next-line typescript/method-signature-style -- Preserve native driver parameter compatibility, including narrower tuples, under strictFunctionTypes.
type NativeDriverMethod<Args extends unknown[], Result> = { call(...args: Args): Result }["call"];

/**
 * Pg's Pool, Client and PoolClient; PGlite and its transactions; Neon's Pool and Client;
 * pg-promise's database, tasks and transactions; @vercel/postgres: query(text, values) → { rows }
 * (pg-promise resolves to the rows themselves, and its types say any).
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type PgQueryClient = {
  query: NativeDriverMethod<[text: string, values?: DriverValue[]], PromiseLike<{ rows: unknown[] }>>;
  /** Mariadb's query() resolves to any as well; its escapeId() tells it apart. */
  escapeId?: never;
};
/**
 * Neon's neon() function from 1.0: query(text, values) → rows. Its transaction() tells it from
 * mysql2/promise, whose query(text, values) resolves to a [rows, fields] array as well.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type NeonHttpClient = {
  query: NativeDriverMethod<[text: string, values?: DriverValue[]], PromiseLike<Record<string, unknown>[]>>;
  transaction: NativeDriverMethod<[...args: DriverValue[]], unknown>;
};
/** Postgres.js `sql`, its begin and savepoint transactions and reserved connections; Bun.sql, likewise: unsafe(text, params) → rows. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type UnsafeClient = {
  unsafe: NativeDriverMethod<[text: string, params?: DriverValue[]], PromiseLike<unknown[]>>;
};
/** Bun.sql on MySQL or SQLite; commitDistributed() tells it from postgres.js, which has unsafe() too. */
export type BunSqlClient = UnsafeClient & { commitDistributed: NativeDriverMethod<[name: string], Promise<unknown>> };
/** Neon's neon() function before 1.0, which is called with (text, params). */
export type CallableClient = (text: string, params?: DriverValue[]) => PromiseLike<unknown[] | { rows: unknown[] }>;
/** Slonik's pool, connections, transactions and savepoints, whose query() takes only its sql tag's queries. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type SlonikClient = {
  query: NativeDriverMethod<[sql: DriverValue], PromiseLike<unknown>>;
  maybeOneFirst: NativeDriverMethod<[...args: DriverValue[]], unknown>;
  anyFirst: NativeDriverMethod<[...args: DriverValue[]], unknown>;
};
/**
 * Mysql2/promise Pool, Connection and PoolConnection (→ [rows, fields]); PlanetScale's Connection,
 * Client and transaction from 1.x (→ { rows }). PlanetScale 2.0 binds no parameters, so its
 * execute(query, options) is not one of these.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type MysqlExecuteClient = {
  execute: NativeDriverMethod<[text: string, values?: DriverValue[]], PromiseLike<[unknown, unknown] | { rows: unknown[]; statement: string }>>;
};
/** Mysql2's callback Pool, Connection and PoolConnection, run through their promise() wrapper. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type Mysql2CallbackClient = { promise: () => MysqlExecuteClient };
/** Mariadb's Pool, Connection and PoolConnection: query(text, values) → rows, or an OK packet for a write. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type MariadbClient = {
  query: NativeDriverMethod<[text: string, values?: DriverValue], Promise<unknown>>;
  batch: NativeDriverMethod<[text: string, values?: DriverValue], Promise<unknown>>;
};
/** The same from mariadb's callback API (`mariadb/callback`): query(text, values, callback). */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type MariadbCallbackClient = {
  query: NativeDriverMethod<[text: string, values: DriverValue, callback: (error: Error | null, rows?: DriverValue) => void], void>;
  batch: NativeDriverMethod<[text: string, values: DriverValue, callback: (error: Error | null, result?: DriverValue) => void], void>;
};
/**
 * Better-sqlite3, node:sqlite's DatabaseSync, bun:sqlite's Database and the Database of Turso's
 * `@tursodatabase/database/compat`, which answer at once: `runSync` takes them and returns the
 * result itself, so it works inside their `db.transaction(fn)`, whose function must not await.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type SyncSqliteClient = {
  prepare: NativeDriverMethod<[sql: string], { all: NativeDriverMethod<[...params: DriverValue[]], unknown[]> }>;
};
/**
 * A SQLite-backed Durable Object's SQL storage, `ctx.storage.sql`: exec(sql, ...values) answers at
 * once with a cursor, so `runSync` takes it, inside `ctx.storage.transactionSync(fn)` too.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type DurableObjectSql = {
  exec: NativeDriverMethod<[query: string, ...bindings: DriverValue[]], { toArray: () => unknown[] }>;
  // oxlint-disable-next-line rules/no-readonly -- Cloudflare exposes this size as a read-only property on its native SQL storage interface.
  readonly databaseSize: number;
};
/** A Durable Object's storage, `ctx.storage`, which `drizzle-orm/durable-sqlite` keeps: `run` takes its `sql`. */
export type DurableObjectStorage = Readonly<{ sql: DurableObjectSql }>;
/** Cloudflare D1's database and sessions: prepare(sql).bind(...values).all() → { results }. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type D1Client = {
  prepare: NativeDriverMethod<[sql: string], {
    bind: NativeDriverMethod<[...values: DriverValue[]], {
      all: () => Promise<{ results: unknown[] }>;
    }>;
  }>;
};
/** @libsql/client's Client and Transaction: execute({ sql, args }) → { rows }. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type LibsqlClient = {
  execute: NativeDriverMethod<[statement: { sql: string; args: DriverValue[] }], Promise<{ rows: unknown[] }>>;
  /** Mariadb's execute() takes an object with sql and resolves to any; executeMultiple() tells libSQL apart. */
  executeMultiple: NativeDriverMethod<[sql: string], Promise<unknown>>;
};
/**
 * Turso's new engine, `@tursodatabase/database`: the Database `connect()` resolves to and the
 * Transaction `transactionAsync()` hands its callback, whose statements answer through a promise:
 * prepare(sql).all(...values) → rows. Its types say prepare() returns a promise of the statement
 * from 0.6, and the statement itself before; it returns the statement itself in every release.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type TursoClient = {
  prepare: NativeDriverMethod<[sql: string], TursoStatement | PromiseLike<TursoStatement>>;
  /** Postgres.js's transaction has a prepare(name) of any type too; exec() tells Turso's apart. */
  exec: NativeDriverMethod<[sql: string], Promise<unknown>>;
};
interface TursoStatement { all: NativeDriverMethod<[...params: DriverValue[]], Promise<unknown[]>> }
/** The sqlite3 package's callback Database: all(sql, params, callback). */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type Sqlite3Client = {
  all: NativeDriverMethod<[sql: string, params: DriverValue[], callback: (error: Error | null, rows: DriverValue[]) => void], unknown>;
};
/** The sqlite package's promise Database: all(sql, params) → rows. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type SqlitePromiseClient = {
  all: NativeDriverMethod<[sql: string, params?: DriverValue], Promise<unknown[]>>;
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
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type DrizzlePgTransaction = { rollback: () => never; setTransaction: NativeDriverMethod<[config: DriverValue], Promise<void>> };
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type DrizzleMysqlTransaction = { rollback: () => never; execute: NativeDriverMethod<[query: DriverValue], unknown>; setTransaction?: never; get?: never };
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type DrizzleSqliteTransaction = { rollback: () => never; get: NativeDriverMethod<[query: DriverValue], unknown>; all: NativeDriverMethod<[query: DriverValue], unknown> };
/** A transaction of a synchronous SQLite driver's Drizzle database, whose `all()` returns the rows themselves. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Keep this exported client alias closed and assignable to structural record consumers.
export type DrizzleSyncSqliteTransaction = { rollback: () => never; get: NativeDriverMethod<[query: DriverValue], unknown>; all: NativeDriverMethod<[query: DriverValue], unknown[]> };
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

/**
 * The parameters: an object keyed by name, or by number for positional placeholders (`$1` and
 * `?` give `{ 1: ..., 2: ... }`, and `params` is `["1", "2"]`). An array is refused, since
 * 2026-10-20 (wiki/design.md §9).
 */
export type ParamsInput = Record<string, unknown>;
