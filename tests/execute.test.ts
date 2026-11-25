// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { execute } from '#reylo-source/execute.ts';
import { defineQuery } from "#reylo-source/index.ts";
import { nativeDriverDate, promiseDriverStub, NO_ROW, requireFixtureValue } from "./helpers.ts";
import type { EmptyParameters } from "./helpers.ts";
import { asyncDriverMarker, driverPromise, driverRow, driverRows } from "./driver-fixtures.ts";
import { pg } from "./execute-test-fixtures.ts";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the driver's own error comes through unchanged", async () => {
  // oxlint-disable-next-line rules/require-tagged-error -- The test must observe this exact native driver error object.
  const duplicate = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  const client = { query: promiseDriverStub(() => {throw duplicate;}) };
  await assert.rejects(driverPromise(execute(client, pg, { id: 1 })), (candidate) => candidate === duplicate);
  const db = new DatabaseSync(":memory:");
  const invalidSql = (): unknown[] => driverRows(execute(db, { dialect: "sqlite", params: [], sql: "selec 1" }));
  try {
    assert.throws(invalidSql, /syntax error/u);
  } finally {
    db.close();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("runSync: on a synchronous client the value comes back at once and an error is thrown, so db.transaction(fn) rolls back", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table users (id integer primary key, email text unique)");
  const insert = defineQuery<{ email: string }, { id: number }, "one", "sqlite">({ cardinality: "one", dialect: "sqlite", params: ["email"], sql: "insert into users (email) values (:email) returning id" });
  const count = defineQuery<EmptyParameters, { n: number }, "one", "sqlite">({ cardinality: "one", dialect: "sqlite", params: [], sql: "select count(*) as n from users" });
  // Better-sqlite3's and bun:sqlite's transaction(fn): BEGIN, the function, then COMMIT, or ROLLBACK if it throws.
  const transaction = (fn: () => void): void => {
    db.exec("begin");
    try {
      fn();
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  };
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  const first = insert.runSync(db, { email: "ada@example.com" });
  assert.equal(first.id, 1);
  assert.throws(() => {transaction(() => {
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    insert.runSync(db, { email: "bo@example.com" });
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    insert.runSync(db, { email: "ada@example.com" });
  });}, /UNIQUE constraint failed/u);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.equal(count.runSync(db).n, 1, "the transaction's first insert was rolled back");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => defineQuery<EmptyParameters, unknown, "one", "sqlite">({ cardinality: "one", dialect: "sqlite", params: [], sql: "select 1 where 0" }).runSync(db), /Expected exactly one row, got 0/u);
});

const checkStoredRow = async function (db: DatabaseSync, pending: Promise<{ id: number }>): Promise<void> {
  assert.ok(pending instanceof Promise);
  const stored = db.prepare("select count(*) as n from users").get();
  assert.equal(driverRow(stored).n, 1, "the insert ran before run returned");
  const inserted = await pending;
  assert.equal(inserted.id, 1);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("run: on a synchronous client the statement runs at once, and its rows and its error still come through the promise", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table users (id integer primary key, email text unique)");
  const insert = defineQuery<{ email: string }, { id: number }, "one", "sqlite">({ cardinality: "one", dialect: "sqlite", params: ["email"], sql: "insert into users (email) values (:email) returning id" });
  const pending = insert.run(db, { email: "ada@example.com" });
  await checkStoredRow(db, pending);
  const duplicate = insert.run(db, { email: "ada@example.com" });
  await assert.rejects(driverPromise(duplicate), /UNIQUE constraint failed/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("runSync: a client that answers through a promise, or a Postgres or MySQL statement, is refused before anything runs", () => {
  const calls: string[] = [];
  const wrong = promiseDriverStub(() => {
    calls.push("driver");
    return { rows: [] };
  });
  const libsql = { execute: wrong, executeMultiple: asyncDriverMarker };
  const lite = defineQuery<EmptyParameters, unknown, "many", "sqlite">({ dialect: "sqlite", params: [], sql: "select 1" });
  // @ts-expect-error The synchronous SQLite method excludes asynchronous driver clients.
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This is Reylo's native SQLite method and it does not run Effect.
  assert.throws(() => lite.runSync(libsql), /runSync takes a synchronous SQLite client .*answers through a promise\. run takes every client/u);
  const pgq = defineQuery<EmptyParameters, unknown, "many", "postgres">({ dialect: "postgres", params: [], sql: "select 1" });
  // @ts-expect-error The synchronous method is unavailable for Postgres statements.
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This is Reylo's own synchronous query method and it does not run Effect.
  assert.throws(() => pgq.runSync({ query: wrong }), /a postgres statement has none/u);
  assert.deepEqual(calls, []);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("run: on an asynchronous client every failure is a rejection, never a throw", async () => {
  const currentQuery = defineQuery<{ id: number }, { id: number }, "maybeOne", "postgres">({ cardinality: "maybeOne", dialect: "postgres", params: ["id"], sql: "select :id::int as id" });
  const two = { query: promiseDriverStub(() => ({ rows: [{ id: 1 }, { id: 2 }] })) };
  const returned = currentQuery.run(two, { id: 1 });
  await assert.rejects(driverPromise(returned), /Expected at most one row, got 2/u);
  // @ts-expect-error A client with no driver methods must fail the compile-time contract as well.
  await assert.rejects(currentQuery.run({}, { id: 1 }), TypeError);
  assert.deepEqual(await currentQuery.with({ query: promiseDriverStub(() => ({ rows: [] })) })({ id: 1 }), NO_ROW);
});

const rejectionOf = async function (pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  return assert.fail("The query must reject");
};

const checkBoundParameterSource = async function (bound: (params: { at: string }) => Promise<unknown>): Promise<void> {
  // @ts-expect-error A timestamptz parameter is a string, and the runtime must also reject a Date.
  const pending = bound({ at: nativeDriverDate() });
  const viaWith = await rejectionOf(pending);
  assert.ok(viaWith instanceof TypeError);
  assert.match(requireFixtureValue(viaWith.stack), /^TypeError: at\.sql: Parameter "at" is a timestamptz, which takes the instant as a string/u);
};

const checkParameterSource = async function (): Promise<void> {
  const query = defineQuery<{ at: string }, unknown, "many", "postgres">({ cardinality: "many", dialect: "postgres", inputs: { at: { type: { kind: "scalar", name: "timestamptz" } } }, params: ["at"], source: "at.sql", sql: "select :at::timestamptz as at" });
  const client = { query: promiseDriverStub(() => ({ rows: [] })) };
  const rejected = await rejectionOf(query.run(client, { at: "2026-10-12 19:06:48" }));
  assert.ok(rejected instanceof TypeError);
  assert.match(rejected.message, /^at\.sql: Parameter "at" is a timestamptz/u);
  assert.match(requireFixtureValue(rejected.stack), /^TypeError: at\.sql: Parameter "at"/u);
  await checkBoundParameterSource(query.with(client));
};

const checkSqliteSourceErrors = async function (db: DatabaseSync): Promise<void> {
  // A column's value Reylo cannot give its kind.
  const truth = defineQuery<EmptyParameters, unknown, "many", "sqlite">({ columns: [["b", "bool"]], dialect: "sqlite", params: [], source: "truth.sql", sql: "select 2 as b" });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => truth.runSync(db), (candidate: unknown) => candidate instanceof TypeError && candidate.message.startsWith('truth.sql: Column "b" is a boolean'));
  await assert.rejects(truth.run(db), { message: /^truth\.sql: Column "b" is a boolean/u });
  // The driver's own error passes through as it is.
  const insert = defineQuery<{ email: string }, unknown, "none", "sqlite">({ cardinality: "none", dialect: "sqlite", params: ["email"], source: "insert.sql", sql: "insert into users (email) values (:email)" });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  insert.runSync(db, { email: "ada@example.com" });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => {insert.runSync(db, { email: "ada@example.com" });}, { message: /^UNIQUE constraint failed/u });
  await assert.rejects(insert.run(db, { email: "ada@example.com" }), { message: /^UNIQUE constraint failed/u });
};

const checkBareSource = function (db: DatabaseSync): void {
  // A query defined by hand, with no file, keeps its messages as they are.
  const bare = defineQuery<EmptyParameters, unknown, "one", "sqlite">({ cardinality: "one", dialect: "sqlite", params: [], sql: "select 1 where 0" });
  assert.equal(bare.source, undefined);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => bare.runSync(db), { message: "Expected exactly one row, got 0" });
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a query's source names its file, and Reylo's own errors about the query start with it", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table users (id integer primary key, email text unique)");
  const one = defineQuery<EmptyParameters, unknown, "one", "sqlite">({ cardinality: "one", dialect: "sqlite", params: [], source: "queries/none.sql", sql: "select 1 where 0" });
  assert.equal(one.source, "queries/none.sql");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => one.runSync(db), /^Error: queries\/none\.sql: Expected exactly one row, got 0$/mu);
  await assert.rejects(one.run(db), { message: "queries/none.sql: Expected exactly one row, got 0" });
  await checkParameterSource();
  await checkSqliteSourceErrors(db);
  checkBareSource(db);
});
