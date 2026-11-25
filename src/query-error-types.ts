import type { Dialect } from "./execute.ts";
import type { MYSQL_CODES } from "./error-codes-mysql.ts";
import type { POSTGRES_CODES } from "./error-codes-postgres.ts";
import type { SQLITE_CODES } from "./error-codes-sqlite.ts";

type NativeError = Omit<Error, "name" | "message" | "cause">;

/** A SQLSTATE Postgres defines, as `"23505"`. */
export type PostgresCode = keyof typeof POSTGRES_CODES;
/** The condition name of a SQLSTATE Postgres defines, as `"unique_violation"`. */
export type PostgresCondition = (typeof POSTGRES_CODES)[PostgresCode];
/** The name of an error MySQL sends a client, as `"ER_DUP_ENTRY"`. */
export type MysqlCode = (typeof MYSQL_CODES)[number] extends Readonly<[number, Readonly<(infer Name)[]>]> ? Name : never;
/** The name of a SQLite result code of an error, primary or extended, as `"SQLITE_CONSTRAINT_UNIQUE"`. */
export type SqliteCode = keyof typeof SQLITE_CODES;

/** What an error Postgres raised holds beside its code. */
export interface PostgresErrorFields extends NativeError, Readonly<{
  name: "QueryError";
  /** `ERROR`, `FATAL` (the session ended) or `PANIC` (the server stopped), in the server's language with pg. */
  severity: string;
  /** The server's message, as `duplicate key value violates unique constraint "users_email_key"`. */
  message: string;
  detail: string | undefined;
  hint: string | undefined;
  /** Where in the statement the error is: a character's place, from 1. */
  position: number | undefined;
  /** The functions the error was raised in, innermost first. */
  where: string | undefined;
  schema: string | undefined;
  table: string | undefined;
  column: string | undefined;
  dataType: string | undefined;
  constraint: string | undefined;
  /** The driver's own error. */
  cause: unknown;
}> {}

/**
 * The names each field of an error may hold, by the error's code: what a statement that runs only
 * the server's own code writes through (its constraints, tables, columns and domains).
 */
export type PostgresNarrowing = Readonly<Partial<Record<PostgresCode, Readonly<{ constraint?: string; table?: string; column?: string; dataType?: string }>>>>;

/** An error of one of the codes `C`, with the names `F` narrows its fields to. */
type PostgresCodeField<C extends PostgresCode> = Readonly<{
  /** The SQLSTATE, as `"23505"`. */
  code: C;
  /** The code's condition name, as `"unique_violation"`. */
  condition: (typeof POSTGRES_CODES)[C];
}>;

type PostgresMember<C extends PostgresCode, F> =
  Omit<PostgresErrorFields, keyof F> & PostgresCodeField<C> & Readonly<{ [K in keyof F]: F[K] | undefined }>;

/**
 * An error Postgres raised. A statement that may run a user's code (a trigger, a function) may raise
 * any code: `code` is any string, and `condition` the strict union, undefined for a code Postgres
 * does not define. Where a statement runs only the server's own code, its module narrows the type
 * with `N`: a code Postgres defines, and for each code `N` lists, the names its fields may hold.
 */
export type PostgresQueryError<N extends PostgresNarrowing | undefined = undefined> = [N] extends [PostgresNarrowing]
  ? { [C in keyof N & PostgresCode]: PostgresMember<C, N[C]> }[keyof N & PostgresCode] | (PostgresErrorFields & PostgresCodeField<Exclude<PostgresCode, keyof N>>)
  : PostgresErrorFields & Readonly<{
      /**
       * The SQLSTATE, as `"23505"`: one Postgres defines, or one a function raised itself
       * (`raise ... using errcode`), which no list holds.
       */
      // oxlint-disable-next-line typescript/ban-types -- Keep completion for known SQLSTATE literals while accepting custom codes.
      code: PostgresCode | (string & {});
      /** The code's condition name, as `"unique_violation"`; undefined for a code Postgres does not define. */
      condition: PostgresCondition | undefined;
    }>;

/** What an error MySQL raised holds beside its code. */
export interface MysqlErrorFields extends NativeError, Readonly<{
  name: "QueryError";
  /** The error's number, as `1062`. */
  errno: number;
  /** The SQLSTATE, as `"23000"`. */
  sqlState: string;
  /** The server's message, as `Duplicate entry 'ada@example.com' for key 'users.email'`. */
  message: string;
  /** The key a duplicate entry is for, as the message names it: `users.email`, its table and its name. */
  key: string | undefined;
  /** The foreign key or check constraint the row fails. */
  constraint: string | undefined;
  /** The table of the foreign key a row fails. */
  table: string | undefined;
  /** The column a value does not fit, or a null or a missing value is refused for. */
  column: string | undefined;
  /** The driver's own error. */
  cause: unknown;
}> {}

/** The names each field of an error may hold, by the error's name: what a statement that runs no trigger and no stored function writes through. */
export type MysqlNarrowing = Readonly<Partial<Record<MysqlCode, Readonly<{ key?: string; constraint?: string; table?: string; column?: string }>>>>;

/** An error of one of the names `C`, with the names `F` narrows its fields to. */
type MysqlCodeField<C extends MysqlCode | undefined> = Readonly<{
  /** The error's name, as `"ER_DUP_ENTRY"`; undefined for a number MySQL does not define. */
  code: C;
}>;

type MysqlMember<C extends MysqlCode | undefined, F> =
  Omit<MysqlErrorFields, keyof F> & MysqlCodeField<C> & Readonly<{ [K in keyof F]: F[K] | undefined }>;

/**
 * An error MySQL raised: its name from MySQL's own list, undefined for a number the list lacks, as
 * one a `signal` statement sets. Where a statement runs no trigger and no stored function, its
 * module narrows the type with `N`: for each name `N` lists, the names its fields may hold.
 */
export type MysqlQueryError<N extends MysqlNarrowing | undefined = undefined> = [N] extends [MysqlNarrowing]
  ? { [C in keyof N & MysqlCode]: MysqlMember<C, N[C]> }[keyof N & MysqlCode] | (MysqlErrorFields & MysqlCodeField<Exclude<MysqlCode, keyof N> | undefined>)
  : MysqlErrorFields & MysqlCodeField<MysqlCode | undefined>;

/** What an error SQLite raised holds beside its code. */
export interface SqliteErrorFields extends NativeError, Readonly<{
  name: "QueryError";
  /** The result code's number, as `2067`. */
  errcode: number | undefined;
  /** SQLite's message, as `UNIQUE constraint failed: users.email`. */
  message: string;
  /** The table of the columns a unique, not-null or type constraint fails on. */
  table: string | undefined;
  /** The columns a unique, not-null or type constraint fails on. */
  columns: Readonly<string[]> | undefined;
  /** The check constraint the row fails (its expression, where it has no name), or the index of an expression a unique row fails. */
  constraint: string | undefined;
  /** The driver's own error. */
  cause: unknown;
}> {}

/** The names each field of an error may hold, by the result code's name: what a statement that fires no trigger writes through. */
export type SqliteNarrowing = Readonly<Partial<Record<SqliteCode, Readonly<{ table?: string; columns?: Readonly<string[]>; constraint?: string }>>>>;

/** An error of one of the codes `C`, with the names `F` narrows its fields to. */
type SqliteCodeField<C extends SqliteCode | undefined> = Readonly<{
  /**
   * The result code's name: the extended code, as `"SQLITE_CONSTRAINT_UNIQUE"`, where the driver
   * gives it; the primary code, as `"SQLITE_CONSTRAINT"`, from sqlite3 and the sqlite package,
   * which give only that; undefined where the driver gives none, as Turso's engine.
   */
  code: C;
}>;

type SqliteMember<C extends SqliteCode | undefined, F> =
  Omit<SqliteErrorFields, keyof F> & SqliteCodeField<C> & Readonly<{ [K in keyof F]: F[K] | undefined }>;

/**
 * An error SQLite raised. Where a statement fires no trigger, its module narrows the type with
 * `N`: for each code `N` lists, the names its fields may hold.
 */
export type SqliteQueryError<N extends SqliteNarrowing | undefined = undefined> = [N] extends [SqliteNarrowing]
  ? { [C in keyof N & SqliteCode]: SqliteMember<C, N[C]> }[keyof N & SqliteCode] | (SqliteErrorFields & SqliteCodeField<Exclude<SqliteCode, keyof N> | undefined>)
  : SqliteErrorFields & SqliteCodeField<SqliteCode | undefined>;

/**
 * The kinds of error DuckDB raises, by its exception type: the words its message starts with,
 * `Constraint Error: …` being `CONSTRAINT`.
 */
export const DUCKDB_CODES = {
  Binder: "BINDER",
  Catalog: "CATALOG",
  Connection: "CONNECTION",
  Constraint: "CONSTRAINT",
  Conversion: "CONVERSION",
  Decimal: "DECIMAL",
  Dependency: "DEPENDENCY",
  "Divide by Zero": "DIVIDE_BY_ZERO",
  Executor: "EXECUTOR",
  Expression: "EXPRESSION",
  "Extension Autoloading": "AUTOLOAD",
  FATAL: "FATAL",
  HTTP: "HTTP",
  INTERNAL: "INTERNAL",
  INTERRUPT: "INTERRUPT",
  IO: "IO",
  Index: "INDEX",
  Invalid: "INVALID",
  "Invalid Configuration": "INVALID_CONFIGURATION",
  "Invalid Input": "INVALID_INPUT",
  "Invalid type": "INVALID_TYPE",
  "Mismatch Type": "MISMATCH_TYPE",
  "Missing Extension": "MISSING_EXTENSION",
  Network: "NETWORK",
  "Not implemented": "NOT_IMPLEMENTED",
  NullPointer: "NULL_POINTER",
  "Object Size": "OBJECT_SIZE",
  Optimizer: "OPTIMIZER",
  "Out of Memory": "OUT_OF_MEMORY",
  "Out of Range": "OUT_OF_RANGE",
  "Parameter Not Allowed": "PARAMETER_NOT_ALLOWED",
  "Parameter Not Resolved": "PARAMETER_NOT_RESOLVED",
  Parser: "PARSER",
  Permission: "PERMISSION",
  Planner: "PLANNER",
  Scheduler: "SCHEDULER",
  Sequence: "SEQUENCE",
  Serialization: "SERIALIZATION",
  Settings: "SETTINGS",
  Stat: "STAT",
  Syntax: "SYNTAX",
  TransactionContext: "TRANSACTION",
  "Unknown Type": "UNKNOWN_TYPE",
} as const;

/** The kind of an error DuckDB raised, as `"CONSTRAINT"`. */
export type DuckdbCode = (typeof DUCKDB_CODES)[keyof typeof DUCKDB_CODES];

/** An error DuckDB raised: its kind, undefined for one this list does not name, and its message. */
export interface DuckdbQueryError extends NativeError, Readonly<{
  name: "QueryError";
  code: DuckdbCode | undefined;
  /** DuckDB's message, as `Constraint Error: Duplicate key "id: 1" violates primary key constraint.` */
  message: string;
  /** The driver's own error. */
  cause: unknown;
}> {}

/** The error a database of the dialect raised. */
export type QueryError<D extends Dialect = Dialect> = D extends "postgres" ? PostgresQueryError : D extends "mysql" ? MysqlQueryError : D extends "duckdb" ? DuckdbQueryError : SqliteQueryError;
