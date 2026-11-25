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
import { matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";

import { driverFields, driverText, messageGroup, queryError } from "./query-error-native.ts";
import { sqliteQueryError } from "./query-error-sqlite.ts";
import { DUCKDB_CODES } from "./query-error-types.ts";
import type { DuckdbCode, DuckdbQueryError, MysqlQueryError, PostgresQueryError, QueryError } from "./query-error-types.ts";

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

const SQLSTATE = /^[0-9A-Z]{5}$/u;

const postgresError = function postgresError(error: unknown) {
  const e = driverFields(error);
  if (!e || !matchesString(e.severity) || !matchesString(e.message)) {return undefined;}
  const code = matchesString(e.code) && SQLSTATE.test(e.code) ? e.code : (matchesString(e.errno) && SQLSTATE.test(e.errno) ? e.errno : undefined);
  if (matchesUndefined(code)) {return undefined;}
  const position = driverText(e.position);
  return {
    code,
    message: e.message,
    fields: {
      severity: e.severity,
      detail: driverText(e.detail),
      hint: driverText(e.hint),
      position: !matchesUndefined(position) && /^\d+$/u.test(position) ? Number(position) : undefined,
      where: driverText(e.where),
      schema: driverText(e.schema ?? e.schema_name),
      table: driverText(e.table ?? e.table_name),
      column: driverText(e.column ?? e.column_name),
      dataType: driverText(e.dataType ?? e["data type_name"]),
      constraint: driverText(e.constraint ?? e.constraint_name),
    },
  };
};

const mysqlError = function mysqlError(error: unknown) {
  const e = driverFields(error);
  if (!e || !matchesString(e.message)) {return undefined;}
  let { errno, sqlState } = e;
  let message = driverText(e.sqlMessage) ?? driverText(e.text) ?? e.message;
  if (matchesUndefined(errno)) {
    // `<message> (errno 1062) (sqlstate 23000) during query: …`, the message behind Vitess's
    // `target: …: desc = ` on PlanetScale itself.
    const fields = /^(?:[\s\S]*?desc = )?(?<message>[\s\S]*?) \(errno (?<errno>\d+)\) \(sqlstate (?<sqlState>[0-9A-Z]{5})\)/u.exec(e.message)?.groups;
    if (matchesUndefined(fields)) {return undefined;}
    [message, errno, sqlState] = [fields.message ?? "", Number(fields.errno), fields.sqlState];
  }
  // A system error's number is negative (mysql2 and mariadb give ECONNREFUSED as -61).
  if (!matchesNumber(errno) || !Number.isInteger(errno) || errno <= 0 || !matchesString(sqlState) || !SQLSTATE.test(sqlState)) {return undefined;}
  if (errno > 45_000 && errno < 46_000 && /^\(conn[:=]/u.test(e.message)) {return undefined;}
  return { errno, sqlState, message };
};

/** What a MySQL message names, for the errors that name a key, a constraint or a column. */
const mysqlNames = function mysqlNames(errno: number, message: string) {
  const names: { key?: string | undefined; constraint?: string | undefined; table?: string | undefined; column?: string | undefined } = {};
  switch (errno) {
    case 1062: // ER_DUP_ENTRY
    case 1586: { // ER_DUP_ENTRY_WITH_KEY_NAME
      names.key = messageGroup(/^Duplicate entry '[\s\S]*' for key '(?<key>[\s\S]*)'$/u, message, "key");
      break;
    }
    case 1451: // ER_ROW_IS_REFERENCED_2
    case 1452: { // ER_NO_REFERENCED_ROW_2
      const fields = /a foreign key constraint fails \(`(?:[^`]|``)*`\.`(?<table>(?:[^`]|``)*)`, CONSTRAINT `(?<constraint>(?:[^`]|``)*)`/u.exec(message)?.groups;
      names.table = fields?.table?.replaceAll("``", "`");
      names.constraint = fields?.constraint?.replaceAll("``", "`");
      break;
    }
    case 3819: { // ER_CHECK_CONSTRAINT_VIOLATED
      names.constraint = messageGroup(/^Check constraint '(?<constraint>[\s\S]*)' is violated\.$/u, message, "constraint");
      break;
    }
    case 1048: { // ER_BAD_NULL_ERROR
      names.column = messageGroup(/^Column '(?<column>[\s\S]*)' cannot be null$/u, message, "column");
      break;
    }
    case 1364: { // ER_NO_DEFAULT_FOR_FIELD
      names.column = messageGroup(/^Field '(?<column>[\s\S]*)' doesn't have a default value$/u, message, "column");
      break;
    }
    case 1264: // ER_WARN_DATA_OUT_OF_RANGE
    case 1265: // WARN_DATA_TRUNCATED
    case 1292: // ER_TRUNCATED_WRONG_VALUE
    case 1366: // ER_TRUNCATED_WRONG_VALUE_FOR_FIELD
    case 1406: { // ER_DATA_TOO_LONG
      names.column = messageGroup(/ for column '(?<column>[\s\S]*)' at row \d+$/u, message, "column");
      break;
    }
  }
  return { key: names.key, constraint: names.constraint, table: names.table, column: names.column };
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

/** The database's error `error` is, or undefined where it is another. */
export const readQueryError = async function readQueryError(dialect: Dialect, error: unknown): Promise<QueryError | undefined> {
  if (dialect === "sqlite") {return sqliteQueryError(error);}
  if (dialect === "duckdb") {
    // A plain Error, its message opening with the kind of error: Reylo's own errors are of classes of their own.
    const e = driverFields(error);
    const kind = error instanceof Error && Object.getPrototypeOf(error) === Error.prototype && matchesString(e?.message) ? messageGroup(/^(?<kind>[A-Za-z ]+?) Error: /u, e.message, "kind") : undefined;
    if (matchesUndefined(kind)) {return undefined;}
    return queryError(e!.message as string, error, { code: (DUCKDB_CODES as Record<string, DuckdbCode>)[kind] }) as DuckdbQueryError;
  }
  if (dialect === "postgres") {
    // Slonik wraps pg's error in its own (InputSyntaxError, UniqueIntegrityConstraintViolationError),
    // Keeping pg's as its cause.
    const read = postgresError(error) ?? postgresError(driverFields(error)?.cause);
    if (!read) {return undefined;}
    // The lists are loaded where an error needs one, so a bundle carries them apart from the run time.
    const { POSTGRES_CODES } = await import("./error-codes-postgres.ts");
    return queryError(read.message, error, { code: read.code, condition: (POSTGRES_CODES as Record<string, string>)[read.code], ...read.fields }) as PostgresQueryError;
  }
  const read = mysqlError(error);
  if (!read) {return undefined;}
  const { MYSQL_CODES } = await import("./error-codes-mysql.ts");
  let code: string | undefined;
  Iterator.from(MYSQL_CODES).forEach(([first, names]) => {if (read.errno >= first && read.errno < first + names.length) {code = names[read.errno - first];}});
  return queryError(read.message, error, { code, errno: read.errno, sqlState: read.sqlState, ...mysqlNames(read.errno, read.message) }) as MysqlQueryError;
};
