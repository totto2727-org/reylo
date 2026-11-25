// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { defineQuery } from '#reylo-source/index.ts';
import type { Query } from "#reylo-source/index.ts";
import { readQueryError, readQueryErrorSync } from "#reylo-source/query-error.ts";
import { forEachFixtureInOrder, promiseDriverStub, SQL_NULL } from "./helpers.ts";
import type { EmptyParameters } from "./helpers.ts";
import { matchesUndefined } from "#reylo-source/native-predicates.ts";
import { Predicate } from "effect";
// `.try()` and the database's error it reads from each driver's own (src/query-error.ts). The
// Drivers' errors below are the ones each throws, measured on the real package (lab/driver-matrix
// Checks them through `.try()` on every driver).

// Construct the driver Error with the fields present in its native response.
const thrown = (message: string, fields: Record<string, unknown> = {}, Constructor: new (message: string) => Error = Error): Error => Object.assign(new Constructor(message), fields);

// Project the error fields while still requiring the original native Error class.
const fields = function (error: unknown): Record<string, unknown> {
  assert.ok(Predicate.isError(error));
  assert.equal(error.name, "QueryError");
  // oxlint-disable-next-line typescript/no-misused-spread -- Compare enumerable driver fields and the message independently of the Error prototype.
  return { ...error, message: error.message };
};

type ErrorCase = [label: string, error: Error, expected: Record<string, unknown> | undefined];

const checkReadError = function (fixture: ErrorCase, read: unknown): void {
  const [label, error, expected] = fixture;
  if (matchesUndefined(expected)) {
    assert.equal(read, undefined, label);
    return;
  }
  assert.deepEqual(fields(read), expected, label);
  assert.ok(Predicate.isError(read), label);
  assert.equal(read.cause, error, label);
};

const PG_NONE = { column: undefined, constraint: undefined, dataType: undefined, detail: undefined, hint: undefined, position: undefined, schema: undefined, severity: "ERROR", table: undefined, where: undefined };

const POSTGRES_CASES: ErrorCase[] = [
  [
    "pg (and pg-promise, Neon's Pool and PGlite, whose class name is minified)",
    thrown(`duplicate key value violates unique constraint "t_email_key"`, { code: "23505", constraint: "t_email_key", detail: "Key (email)=(a) already exists.", file: "nbtinsert.c", length: 183, line: "673", name: "error", routine: "_bt_check_unique", schema: "rs_probe", severity: "ERROR", table: "t" }),
    { ...PG_NONE, code: "23505", condition: "unique_violation", constraint: "t_email_key", detail: "Key (email)=(a) already exists.", message: `duplicate key value violates unique constraint "t_email_key"`, schema: "rs_probe", table: "t" },
  ],
  [
    "postgres.js, which names the fields as the protocol does",
    thrown(`null value in column "email" of relation "t" violates not-null constraint`, { code: "23502", column_name: "email", detail: "Failing row contains (3, null, 1, null).", file: "execMain.c", line: "2219", name: "PostgresError", query: "insert …", routine: "ReportNotNullViolationError", schema_name: "rs_probe", severity: "ERROR", severity_local: "ERROR", table_name: "t" }),
    { ...PG_NONE, code: "23502", column: "email", condition: "not_null_violation", detail: "Failing row contains (3, null, 1, null).", message: `null value in column "email" of relation "t" violates not-null constraint`, schema: "rs_probe", table: "t" },
  ],
  [
    "postgres.js on a domain, whose type is `data type_name`",
    thrown(`value for domain rs_probe.positive violates check constraint "positive_check"`, { code: "23514", constraint_name: "positive_check", "data type_name": "positive", schema_name: "rs_probe", severity: "ERROR" }),
    { ...PG_NONE, code: "23514", condition: "check_violation", constraint: "positive_check", dataType: "positive", message: `value for domain rs_probe.positive violates check constraint "positive_check"`, schema: "rs_probe" },
  ],
  [
    "Bun.sql, which keeps the SQLSTATE in errno and its own stack's column in column",
    thrown(`duplicate key value violates unique constraint "t_email_key"`, { code: "ERR_POSTGRES_SERVER_ERROR", column: 27, constraint: "t_email_key", detail: "Key (email)=(a) already exists.", errno: "23505", line: "673", name: "PostgresError", schema: "rs_probe", severity: "ERROR", table: "t" }),
    { ...PG_NONE, code: "23505", condition: "unique_violation", constraint: "t_email_key", detail: "Key (email)=(a) already exists.", message: `duplicate key value violates unique constraint "t_email_key"`, schema: "rs_probe", table: "t" },
  ],
  [
    "Bun.sql, where the server sent the column",
    thrown(`null value in column "email" of relation "t" violates not-null constraint`, { code: "ERR_POSTGRES_SERVER_ERROR", column: "email", errno: "23502", line: "2219", schema: "rs_probe", severity: "ERROR", table: "t" }),
    { ...PG_NONE, code: "23502", column: "email", condition: "not_null_violation", message: `null value in column "email" of relation "t" violates not-null constraint`, schema: "rs_probe", table: "t" },
  ],
  [
    "a syntax error, its position a number",
    thrown(`syntax error at or near "selec"`, { code: "42601", name: "error", position: "1", severity: "ERROR" }),
    { ...PG_NONE, code: "42601", condition: "syntax_error", message: `syntax error at or near "selec"`, position: 1 },
  ],
  [
    "a code a function raised, which Postgres does not define",
    thrown("custom", { code: "U0001", detail: "d", severity: "ERROR", where: "PL/pgSQL function rs_probe.boom() line 1 at RAISE" }),
    { ...PG_NONE, code: "U0001", condition: undefined, detail: "d", message: "custom", where: "PL/pgSQL function rs_probe.boom() line 1 at RAISE" },
  ],
  ["a refused connection", thrown("connect ECONNREFUSED 127.0.0.1:1", { code: "ECONNREFUSED", errno: -61, syscall: "connect" }), undefined],
  ["a broken pipe, whose code looks like a SQLSTATE", thrown("write EPIPE", { code: "EPIPE", errno: -32, syscall: "write" }), undefined],
  ["Bun.sql's refused connection", thrown("Failed to connect", { code: "ERR_POSTGRES_CONNECTION_REFUSED", name: "PostgresError" }), undefined],
  ["postgres.js's closed connection", thrown("write CONNECTION_CLOSED 127.0.0.1:5432", { code: "CONNECTION_CLOSED", errno: "CONNECTION_CLOSED" }), undefined],
];

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Postgres: the error each driver throws reads as one, with the server's fields under one name each", async () => {
  await forEachFixtureInOrder(POSTGRES_CASES, async (fixture) => {
    const result = await readQueryError("postgres", fixture[1]);
    checkReadError(fixture, result);
  });
});

const MY_NONE = { column: undefined, constraint: undefined, key: undefined, table: undefined };

const MYSQL_CASES: ErrorCase[] = [
  [
    "mysql2",
    thrown("Duplicate entry 'a' for key 't.email'", { code: "ER_DUP_ENTRY", errno: 1062, sql: "insert …", sqlMessage: "Duplicate entry 'a' for key 't.email'", sqlState: "23000" }),
    { ...MY_NONE, code: "ER_DUP_ENTRY", errno: 1062, key: "t.email", message: "Duplicate entry 'a' for key 't.email'", sqlState: "23000" },
  ],
  [
    "mariadb, whose message has a header of its own",
    thrown("(conn:111, no: 1452, SQLState: 23000) Cannot add or update a child row: a foreign key constraint fails (`rs_probe`.`t`, CONSTRAINT `t_pid` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`))\nsql: insert … - parameters:[]", {
      code: "ER_NO_REFERENCED_ROW_2",
      errno: 1452,
      fatal: false,
      name: "SqlError",
      sqlMessage: "Cannot add or update a child row: a foreign key constraint fails (`rs_probe`.`t`, CONSTRAINT `t_pid` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`))",
      sqlState: "23000",
    }),
    { ...MY_NONE, code: "ER_NO_REFERENCED_ROW_2", constraint: "t_pid", errno: 1452, message: "Cannot add or update a child row: a foreign key constraint fails (`rs_probe`.`t`, CONSTRAINT `t_pid` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`))", sqlState: "23000", table: "t" },
  ],
  [
    "mariadb 2, which keeps the server's message in text",
    thrown("(conn=112, no: 1062, SQLState: 23000) Duplicate entry 'a' for key 't.email'\nsql: insert … - parameters:[]", { code: "ER_DUP_ENTRY", errno: 1062, fatal: false, sqlState: "23000", text: "Duplicate entry 'a' for key 't.email'" }),
    { ...MY_NONE, code: "ER_DUP_ENTRY", errno: 1062, key: "t.email", message: "Duplicate entry 'a' for key 't.email'", sqlState: "23000" },
  ],
  [
    "Bun.sql, which gives a name of its own",
    thrown("You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'selec 1' at line 1", { code: "ERR_MYSQL_SYNTAX_ERROR", errno: 1064, name: "MySQLError", sqlState: "42000" }),
    { ...MY_NONE, code: "ER_PARSE_ERROR", errno: 1064, message: "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'selec 1' at line 1", sqlState: "42000" },
  ],
  [
    "@planetscale/database, which writes the number and the state into the message",
    thrown("Duplicate entry 'taken' for key 'uniq.PRIMARY' (errno 1062) (sqlstate 23000) during query: insert into uniq (k) values ('taken')", { body: { code: "UNKNOWN", message: "…" }, name: "DatabaseError", status: 400 }),
    { ...MY_NONE, code: "ER_DUP_ENTRY", errno: 1062, key: "uniq.PRIMARY", message: "Duplicate entry 'taken' for key 'uniq.PRIMARY'", sqlState: "23000" },
  ],
  [
    "@planetscale/database on PlanetScale itself, behind Vitess's prefix",
    thrown(`target: app.-.primary: vttablet: rpc error: code = AlreadyExists desc = Duplicate entry '1' for key 'users.PRIMARY' (errno 1062) (sqlstate 23000) (CallerID: planetscale-admin): Sql: "insert into users(id) values (:vtg1 /* INT64 */)", BindVars: {REDACTED}`, { body: { code: "UNKNOWN" }, name: "DatabaseError", status: 400 }),
    { ...MY_NONE, code: "ER_DUP_ENTRY", errno: 1062, key: "users.PRIMARY", message: "Duplicate entry '1' for key 'users.PRIMARY'", sqlState: "23000" },
  ],
  [
    "a number a signal statement set, which MySQL does not define",
    thrown("custom", { errno: 5001, sqlMessage: "custom", sqlState: "45000" }),
    { ...MY_NONE, code: undefined, errno: 5001, message: "custom", sqlState: "45000" },
  ],
  ["a check", thrown("Check constraint 'n_positive' is violated.", { code: "ER_CHECK_CONSTRAINT_VIOLATED", errno: 3819, sqlMessage: "Check constraint 'n_positive' is violated.", sqlState: "HY000" }), { ...MY_NONE, code: "ER_CHECK_CONSTRAINT_VIOLATED", constraint: "n_positive", errno: 3819, message: "Check constraint 'n_positive' is violated.", sqlState: "HY000" }],
  ["a null", thrown("Column 'email' cannot be null", { errno: 1048, sqlMessage: "Column 'email' cannot be null", sqlState: "23000" }), { ...MY_NONE, code: "ER_BAD_NULL_ERROR", column: "email", errno: 1048, message: "Column 'email' cannot be null", sqlState: "23000" }],
  ["a missing value", thrown("Field 'email' doesn't have a default value", { errno: 1364, sqlMessage: "Field 'email' doesn't have a default value", sqlState: "HY000" }), { ...MY_NONE, code: "ER_NO_DEFAULT_FOR_FIELD", column: "email", errno: 1364, message: "Field 'email' doesn't have a default value", sqlState: "HY000" }],
  ["a value too long", thrown("Data too long for column 'email' at row 1", { errno: 1406, sqlMessage: "Data too long for column 'email' at row 1", sqlState: "22001" }), { ...MY_NONE, code: "ER_DATA_TOO_LONG", column: "email", errno: 1406, message: "Data too long for column 'email' at row 1", sqlState: "22001" }],
  ["mysql2's refused connection", thrown("connect ECONNREFUSED 127.0.0.1:1", { code: "ECONNREFUSED", errno: -61, fatal: true, syscall: "connect" }), undefined],
  ["mariadb's refused connection, which has a state", thrown("connect ECONNREFUSED 127.0.0.1:1", { code: "ECONNREFUSED", errno: -61, fatal: true, sqlState: "HY000" }), undefined],
  ["mariadb's own error", thrown("(conn:-1, no: 45001, SQLState: 08S01) Cannot execute new commands: connection closed", { code: "ER_CONNECTION_ALREADY_CLOSED", errno: 45_001, fatal: true, sqlMessage: "Cannot execute new commands: connection closed", sqlState: "08S01" }), undefined],
  ["mysql2's lost connection", thrown("Connection lost: The server closed the connection.", { code: "PROTOCOL_CONNECTION_LOST", fatal: true }), undefined],
];

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("MySQL: the error each driver throws reads as one, named from MySQL's own list, with what its message names", async () => {
  await forEachFixtureInOrder(MYSQL_CASES, async (fixture) => {
    const result = await readQueryError("mysql", fixture[1]);
    checkReadError(fixture, result);
  });
});

const SQ_NONE = { columns: undefined, constraint: undefined, table: undefined };

const SQLITE_CASES: ErrorCase[] = [
  ["better-sqlite3, which names the extended code", thrown("UNIQUE constraint failed: t.id", { code: "SQLITE_CONSTRAINT_PRIMARYKEY" }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_PRIMARYKEY", columns: ["id"], errcode: 1555, message: "UNIQUE constraint failed: t.id", table: "t" }],
  ["bun:sqlite and Bun.sql, which name and number it", thrown("UNIQUE constraint failed: t.email", { byteOffset: -1, code: "SQLITE_CONSTRAINT_UNIQUE", errno: 2067, name: "SQLiteError" }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_UNIQUE", columns: ["email"], errcode: 2067, message: "UNIQUE constraint failed: t.email", table: "t" }],
  ["node:sqlite, which numbers it", thrown("UNIQUE constraint failed: index 't_lower'", { code: "ERR_SQLITE_ERROR", errcode: 2067, errstr: "constraint failed" }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_UNIQUE", constraint: "t_lower", errcode: 2067, message: "UNIQUE constraint failed: index 't_lower'" }],
  ["a unique constraint of two columns", thrown("UNIQUE constraint failed: t.a, t.b", { code: "ERR_SQLITE_ERROR", errcode: 2067 }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_UNIQUE", columns: ["a", "b"], errcode: 2067, message: "UNIQUE constraint failed: t.a, t.b", table: "t" }],
  ["a null", thrown("NOT NULL constraint failed: t.email", { code: "ERR_SQLITE_ERROR", errcode: 1299 }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_NOTNULL", columns: ["email"], errcode: 1299, message: "NOT NULL constraint failed: t.email", table: "t" }],
  ["a named check", thrown("CHECK constraint failed: n_positive", { code: "ERR_SQLITE_ERROR", errcode: 275 }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_CHECK", constraint: "n_positive", errcode: 275, message: "CHECK constraint failed: n_positive" }],
  ["a check with no name, which SQLite names by its expression", thrown("CHECK constraint failed: m < 5", { code: "ERR_SQLITE_ERROR", errcode: 275 }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_CHECK", constraint: "m < 5", errcode: 275, message: "CHECK constraint failed: m < 5" }],
  ["a value a strict table refuses", thrown("cannot store TEXT value in INTEGER column s.x", { code: "ERR_SQLITE_ERROR", errcode: 3091 }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_DATATYPE", columns: ["x"], errcode: 3091, message: "cannot store TEXT value in INTEGER column s.x", table: "s" }],
  ["a trigger's raise()", thrown("custom", { code: "ERR_SQLITE_ERROR", errcode: 1811 }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_TRIGGER", errcode: 1811, message: "custom" }],
  ["a foreign key, which SQLite does not name", thrown("FOREIGN KEY constraint failed", { code: "SQLITE_CONSTRAINT_FOREIGNKEY" }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_FOREIGNKEY", errcode: 787, message: "FOREIGN KEY constraint failed" }],
  ["a syntax error", thrown(`near "selec": syntax error`, { code: "ERR_SQLITE_ERROR", errcode: 1, errstr: "SQL logic error" }), { ...SQ_NONE, code: "SQLITE_ERROR", errcode: 1, message: `near "selec": syntax error` }],
  [
    "libsql 0.17 and later, which name the primary code and the extended one beside it, and start the message with the code",
    thrown("SQLITE_CONSTRAINT: CHECK constraint failed: n_positive", { code: "SQLITE_CONSTRAINT", extendedCode: "SQLITE_CONSTRAINT_CHECK", name: "LibsqlError", rawCode: 275 }),
    { ...SQ_NONE, code: "SQLITE_CONSTRAINT_CHECK", constraint: "n_positive", errcode: 275, message: "CHECK constraint failed: n_positive" },
  ],
  ["libsql before 0.17, which names the extended code", thrown("SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed", { code: "SQLITE_CONSTRAINT_FOREIGNKEY", name: "LibsqlError", rawCode: 787 }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_FOREIGNKEY", errcode: 787, message: "FOREIGN KEY constraint failed" }],
  ["sqlite3 and the sqlite package, which give only the primary code", thrown("SQLITE_CONSTRAINT: UNIQUE constraint failed: index 't_lower'", { code: "SQLITE_CONSTRAINT", errno: 19 }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT", constraint: "t_lower", errcode: 19, message: "UNIQUE constraint failed: index 't_lower'" }],
  ["D1, which writes the codes into the message", thrown("D1_ERROR: NOT NULL constraint failed: t.email: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)"), { ...SQ_NONE, code: "SQLITE_CONSTRAINT_NOTNULL", columns: ["email"], errcode: 1299, message: "NOT NULL constraint failed: t.email", table: "t" }],
  ["a Durable Object, which writes them there too", thrown(`near "selec": syntax error at offset 0: SQLITE_ERROR`), { ...SQ_NONE, code: "SQLITE_ERROR", errcode: 1, message: `near "selec": syntax error at offset 0` }],
  ["Turso's engine from 0.8, which gives no code", thrown("step failed: NOT NULL constraint failed: t.email", { code: "GenericFailure" }), { ...SQ_NONE, code: undefined, errcode: undefined, message: "NOT NULL constraint failed: t.email" }],
  ["Turso's engine before 0.8, which gives the primary code's number", thrown("step failed: Runtime error: UNIQUE constraint failed: uniq.k (19)", { code: "GenericFailure" }), { ...SQ_NONE, code: "SQLITE_CONSTRAINT", columns: ["k"], errcode: 19, message: "UNIQUE constraint failed: uniq.k", table: "uniq" }],
  ["better-sqlite3's closed database", thrown("The database connection is not open", {}, TypeError), undefined],
  ["node:sqlite's closed database", thrown("database is not open", { code: "ERR_INVALID_STATE" }), undefined],
  ["D1's lost connection", thrown("D1_ERROR: Network connection lost."), undefined],
  ["Turso's own error", thrown("database is closed", { code: "GenericFailure" }), undefined],
];

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: the error each driver throws reads as one, its most specific code named and numbered, with what its message names", () => {
  SQLITE_CASES.forEach((fixture) => {
    // oxlint-disable-next-line node/no-sync -- Exercise SQLite's public synchronous error decoder.
    checkReadError(fixture, readQueryErrorSync("sqlite", fixture[1]));
  });
});

interface PostgresStub {
  query: () => Promise<{ rows: unknown[] }>;
}

const answering = (rows: unknown[]): PostgresStub => ({ query: promiseDriverStub(() => ({ rows })) });
const failing = (error: Error): PostgresStub => ({ query: promiseDriverStub(() => {throw error;}) });

interface UserId { id: number }
type UserRows = Query<UserId, UserId, "many", "postgres">;

const postgresRows = defineQuery<UserId, UserId, "many", "postgres">({
  cardinality: "many", dialect: "postgres", params: ["id"], sql: "select id from users where id = :id",
});
const postgresOne = defineQuery<UserId, UserId, "one", "postgres">({
  cardinality: "one", dialect: "postgres", params: ["id"], source: "get_user.sql", sql: "select id from users where id = :id",
});

const checkPostgresFailure = async function (query: UserRows, unique: Error): Promise<void> {
  const failed = await query.try(failing(unique), { id: 1 });
  assert.ok(failed.error);
  assert.equal(failed.error.code, "23505");
  assert.equal(failed.error.condition, "unique_violation");
  assert.equal(failed.error.constraint, "users_email_key");
  assert.equal(failed.error.cause, unique);
  assert.ok(!("value" in failed));
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("try resolves to the value or to the database's error, and rejects with every other error, as run does", async () => {
  const unique = thrown(`duplicate key value violates unique constraint "users_email_key"`, { code: "23505", constraint: "users_email_key", severity: "ERROR", table: "users" });
  const refused = thrown("connect ECONNREFUSED 127.0.0.1:1", { code: "ECONNREFUSED", errno: -61 });
  const result = await postgresRows.try(answering([{ id: 1 }]), { id: 1 });
  assert.deepEqual(result, { value: [{ id: 1 }] });
  assert.ok(!("error" in result));
  await checkPostgresFailure(postgresRows, unique);
  // A refused connection and a wrong row count reject rather than returning a QueryError.
  await assert.rejects(postgresRows.try(failing(refused), { id: 1 }), (error) => error === refused);
  await assert.rejects(postgresOne.try(answering([]), { id: 1 }), /^Error: get_user\.sql: Expected exactly one row, got 0$/u);
  // @ts-expect-error A scalar parameter must fail when the type check is bypassed.
  await assert.rejects(postgresRows.try(answering([]), 1), /The parameters must be an object/u);
});

const sqliteInsert = defineQuery<{ email: string | null }, never, "none", "sqlite">({
  cardinality: "none", dialect: "sqlite", params: ["email"], sql: "insert into users (email) values (:email)",
});
const sqliteGet = defineQuery<UserId, UserId, "one", "sqlite">({
  cardinality: "one", dialect: "sqlite", params: ["id"], sql: "select id from users where id = :id",
});
const sqliteFresh = defineQuery<EmptyParameters, { n: number }, "one", "sqlite">({
  cardinality: "one", dialect: "sqlite", params: [], sql: "select 1 as n",
});

const checkSqliteInsert = function (database: DatabaseSync): void {
  // oxlint-disable-next-line node/no-sync -- Exercise a successful call through the public synchronous API.
  assert.deepEqual(sqliteInsert.trySync(database, { email: "a" }), { value: undefined });
  // oxlint-disable-next-line node/no-sync -- The duplicate's error must be returned from the synchronous driver.
  const unique = sqliteInsert.trySync(database, { email: "a" });
  assert.ok(unique.error);
  assert.deepEqual(fields(unique.error), { code: "SQLITE_CONSTRAINT_UNIQUE", columns: ["email"], constraint: undefined, errcode: 2067, message: "UNIQUE constraint failed: users.email", table: "users" });
  // oxlint-disable-next-line node/no-sync -- The real synchronous driver must enforce the table's null constraint.
  assert.equal(sqliteInsert.trySync(database, { email: SQL_NULL }).error?.code, "SQLITE_CONSTRAINT_NOTNULL");
};

const checkSqliteRows = function (database: DatabaseSync): void {
  // oxlint-disable-next-line node/no-sync -- Verify the row returned from the public synchronous API.
  assert.deepEqual(sqliteGet.trySync(database, { id: 1 }), { value: { id: 1 } });
  // oxlint-disable-next-line node/no-sync -- A synchronous query throws on an unexpected row count.
  assert.throws(() => sqliteGet.trySync(database, { id: 2 }), /^Error: Expected exactly one row, got 0$/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("trySync returns the value or the database's error on a synchronous SQLite client, and throws every other error", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("create table users (id integer primary key, email text unique not null)");
  try {
    checkSqliteInsert(database);
    checkSqliteRows(database);
  } finally {
    database.close();
  }
  // oxlint-disable-next-line node/no-sync -- A closed synchronous database throws its original driver error.
  assert.throws(() => sqliteFresh.trySync(database), /database is not open/u);
});
