// The error `.try()` gives: one the database raised, read from the driver's own error into one
// Shape per database, whichever driver ran the statement. The codes are the database's own, every
// One it defines (the lists are synced from upstream Reylo). Any other error, a refused connection,
// A client Reylo cannot run on, a value Reylo refuses or a row count the analysis got wrong, is not
// The database's, and `.try()` throws it as `.run()` does.
//
// The drivers keep the same facts in different places, measured on each (lab/driver-matrix):
// - Postgres: pg, PGlite and Neon keep the server's fields under pg's names (`constraint`), and
//   Postgres.js under the protocol's (`constraint_name`, and `data type_name` with its space).
//   Bun.sql keeps the SQLSTATE in `errno`, with a name of its own in `code`, and writes its own
//   Stack's column over `column` where the server sent none.
// - MySQL: mysql2, mariadb and Bun.sql give the number and the state; mariadb's message starts with
//   A header of its own, and its `sqlMessage` (`text` before 3.0) is the server's. mariadb numbers
//   Its own errors 45001 to 45999, with a state too. @planetscale/database writes the number and the
//   State into the message.
// - SQLite: better-sqlite3 names the extended code; bun:sqlite and Bun.sql name it and give its
//   Number; node:sqlite gives the number; libsql the number and, from 0.17, the primary code's name
//   With the extended one beside it; sqlite3 and the sqlite package only the primary code. D1 and a
//   Durable Object write both codes at the end of the message, and Turso's engine none, or the
//   Primary one's number before 0.8.
// - DuckDB: @duckdb/node-api throws a plain Error whose message names the kind of error first
//   (`Constraint Error: Duplicate key …`), DuckDB's exception type, and nothing else.
import type { Dialect } from "./execute.ts";
import { matchesString, matchesUndefined } from "./native-predicates.ts";

import { driverFields, messageGroup, queryError } from "./query-error-native.ts";
import { mysqlQueryError } from "./query-error-mysql.ts";
import { postgresQueryError } from "./query-error-postgres.ts";
import { sqliteQueryError } from "./query-error-sqlite.ts";
import { DUCKDB_CODES } from "./query-error-types.ts";
import type { DuckdbCode, DuckdbQueryError, QueryError } from "./query-error-types.ts";

export type {
  DuckdbCode,
  DuckdbQueryError,
  MysqlCode,
  MysqlErrorFields,
  MysqlNarrowing,
  MysqlQueryError,
  PostgresCode,
  PostgresCondition,
  PostgresErrorFields,
  PostgresNarrowing,
  PostgresQueryError,
  QueryError,
  SqliteCode,
  SqliteErrorFields,
  SqliteNarrowing,
  SqliteQueryError,
} from "./query-error-types.ts";

const DUCKDB_NAMES: Readonly<Record<string, DuckdbCode | undefined>> = DUCKDB_CODES;

const duckdbQueryError = (error: unknown): DuckdbQueryError | undefined => {
  // oxlint-disable-next-line rules/no-instanceof-error -- DuckDB reports errors through the native Error prototype, while Reylo's own failures use subclasses.
  if (!(error instanceof Error) || Object.getPrototypeOf(error) !== Error.prototype) {return undefined;}
  const message = driverFields(error)?.message;
  if (!matchesString(message)) {return undefined;}
  const kind = messageGroup(/^(?<kind>[A-Za-z ]+?) Error: /u, message, "kind");
  if (matchesUndefined(kind)) {return undefined;}
  return queryError(message, error, { code: DUCKDB_NAMES[kind] });
};

/**
 * Reads a driver error through the synchronous SQLite boundary.
 * @param {Dialect} dialect The driver dialect.
 * @param {unknown} error The error raised by the driver.
 * @returns {QueryError | undefined} A recognized SQLite error or undefined.
 */
export const readQueryErrorSync = function readQueryErrorSync(dialect: Dialect, error: unknown): QueryError | undefined {
  return dialect === "sqlite" ? sqliteQueryError(error) : undefined;
};

/**
 * Reads the database error fields and preserves the original driver error as the cause.
 * @param {Dialect} dialect The driver's database dialect.
 * @param {unknown} error The driver's reported error.
 * @returns {Promise<QueryError | undefined>} A recognized database error or undefined.
 */
export const readQueryError = async function readQueryError(dialect: Dialect, error: unknown): Promise<QueryError | undefined> {
  if (dialect === "sqlite") {return sqliteQueryError(error);}
  if (dialect === "duckdb") {return duckdbQueryError(error);}
  if (dialect === "postgres") {return postgresQueryError(error);}
  return mysqlQueryError(error);
};
