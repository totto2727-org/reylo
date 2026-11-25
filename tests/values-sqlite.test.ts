// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Compare native decoder and driver results with the test runner's assertions.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { execute } from '#reylo-source/execute.ts';
import type { QueryModule } from '#reylo-source/execute.ts';
import type { BunSqlClient, D1Client, LibsqlClient } from "#reylo-source/execute-types.ts";
import { renderParamType, renderType } from "#reylo-source/render.ts";
import { typeSchema } from "#reylo-source/schema.ts";
import { DecodeError, kindType, scalarKind } from "#reylo-source/values.ts";
import { forEachFixtureInOrder, promiseDriverStub, NO_ROW, SQL_NULL } from "./helpers.ts";
import { asyncDriverMarker, driverPromise, driverRow, driverRows, executeFixture, executeSyncFixture, scalarFixture } from "./driver-fixtures.ts";

interface D1Fixture extends D1Client {
  batch: () => Promise<unknown[]>;
}

const d1Fixture = (results: unknown[]): D1Fixture => {
  const all = promiseDriverStub(() => ({ results }));
  const first = promiseDriverStub(() => NO_ROW);
  const bind = (): { all: typeof all } => ({ all });
  const prepare = (): { bind: typeof bind; first: typeof first } => ({ bind, first });
  return { batch: promiseDriverStub(() => []), prepare };
};

const libsql = (rows: unknown[]): LibsqlClient => ({
  execute: promiseDriverStub(() => ({ rows })),
  executeMultiple: asyncDriverMarker,
});

const bun = (rows: unknown[]): BunSqlClient => ({
  commitDistributed: asyncDriverMarker,
  unsafe: promiseDriverStub(() => rows),
});

const nativeRows = (database: DatabaseSync, query: QueryModule<"sqlite">, params?: Record<string, unknown>): unknown[] =>
  driverRows(execute(database, query, params));

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: the kinds, and a NUMERIC column of either", () => {
  assert.deepEqual(["integer", "real", "text", "blob", "numeric", "bool", "mystery"].map((name) => scalarKind(name, "sqlite")), ["int", "float", "text", "bytes", "int|float|text", "bool", "unknown"]);
  assert.deepEqual(["int", "int|float|text", "unknown", "bytes"].map((kind) => kindType(kind)), ["number", "number | string", "unknown", "Uint8Array"]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a column declared BIGINT, INT8 or UNSIGNED BIG INT (the engine's int8) is a BigInt, as on Postgres and MySQL, and its parameter takes one back", () => {
  assert.equal(scalarKind("int8", "sqlite"), "int8");
  assert.equal(renderType(scalarFixture("int8"), false, "sqlite"), "bigint");
  assert.equal(renderType(scalarFixture("int8"), true, "sqlite"), "number", "inside a JSON document, the number SQLite writes");
  assert.equal(renderParamType(scalarFixture("int8"), "sqlite"), "number | bigint");
  assert.deepEqual(typeSchema(scalarFixture("int8"), "sqlite"), { format: "int64", type: "integer" }, "the BigInt, as the JSON integer it is");
  assert.deepEqual(typeSchema(scalarFixture("int8"), "sqlite"), typeSchema(scalarFixture("int8"), "postgres"));
  // Inside a document a non-finite float or decimal is the text Postgres writes; MySQL stores none.
  assert.deepEqual(typeSchema(scalarFixture("float8"), "postgres", false, true), { anyOf: [{ format: "double", type: "number" }, { enum: ["NaN", "Infinity", "-Infinity"] }] });
  assert.deepEqual(typeSchema(scalarFixture("numeric"), "mysql", false, true), { format: "decimal", type: "number" });
  assert.deepEqual(typeSchema(scalarFixture("interval"), "postgres", false, true), { description: "pg type interval", type: "string" }, "inside a document, Postgres's own text");
  assert.deepEqual(typeSchema(scalarFixture("int8"), "sqlite", true), { format: "int64", type: "integer" }, "a parameter");
});

const checkOtherBigIntDrivers = async function (): Promise<void> {
  const currentQuery: QueryModule<"sqlite"> = { columns: [["n", "int"], ["big", "int8"]], dialect: "sqlite", params: [], sql: "select n, big from t" };
  assert.deepEqual(await execute(d1Fixture([{ big: 9_007_199_254_740_991, n: 5 }, { big: -3, n: 6 }]), currentQuery), [{ big: BigInt("9007199254740991"), n: 5 }, { big: -BigInt("3"), n: 6 }]);
  const roundedD1 = d1Fixture([{ big: 9_007_199_254_740_992, n: 5 }]);
  await assert.rejects(driverPromise(execute(roundedD1, currentQuery)), (candidate: unknown) => candidate instanceof DecodeError && candidate.message.startsWith('Column "big" is a 64-bit integer, and the driver already rounded its value to 9007199254740992'));
  // LibSQL under each intMode: a number, a BigInt or the digits.
  await forEachFixtureInOrder([7, BigInt("7"), "7"], async (big) => {
    const result = await execute(libsql([{ big, n: 5 }]), currentQuery);
    assert.deepEqual(result, [{ big: BigInt("7"), n: 5 }], typeof big);
  });
  assert.deepEqual(await execute(libsql([{ big: "9007199254740993", n: 5 }]), currentQuery), [{ big: BigInt("9007199254740993"), n: 5 }]);
  // Bun.sql's SQLite, with safeIntegers or without.
  const exactBun = bun([{ big: BigInt("9007199254740993"), n: 5 }]);
  assert.deepEqual(await execute(exactBun, currentQuery), [{ big: BigInt("9007199254740993"), n: 5 }]);
  const roundedBun = bun([{ big: 9_007_199_254_740_992, n: 5 }]);
  await assert.rejects(driverPromise(execute(roundedBun, currentQuery)), /Column "big" is a 64-bit integer, and the driver already rounded/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a BIGINT column on node:sqlite exact past 2^53 beside an INTEGER read as a number, whatever the database's setting; on the drivers that round, a BigInt within 2^53 and a rounded value refused", async () => {
  Iterator.from([false, true]).forEach((readBigInts) => {
    const db = new DatabaseSync(":memory:", { readBigInts });
    db.exec("create table t (id integer primary key, n integer, big bigint); insert into t values (1, 5, 9007199254740993), (2, 6, -9007199254740993), (3, 7, null)");
    const fixtureQuery: QueryModule<"sqlite"> = { columns: [["id", "int"], ["n", "int"], ["big", "int8"]], dialect: "sqlite", params: [], sql: "select id, n, big from t order by id" };
    assert.deepEqual(execute(db, fixtureQuery), [{ big: BigInt("9007199254740993"), id: 1, n: 5 }, { big: -BigInt("9007199254740993"), id: 2, n: 6 }, { big: SQL_NULL, id: 3, n: 7 }]);
    // The failing control: the app's own statement at the database's setting, which without
    // ReadBigInts refuses the value with an error that names no column.
    const own = (): Record<string, unknown> => {
      const row = db.prepare("select n, big from t where id = 1").get();
      return { ...driverRow(row) };
    };
    if (readBigInts) {assert.deepEqual(own(), { big: BigInt("9007199254740993"), n: BigInt("5") });}
    else {assert.throws(own, /^RangeError: Value is too large to be represented as a JavaScript number: 9007199254740993/u);}
    db.close();
  });
  await checkOtherBigIntDrivers();
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: Reylo's own statement per database and text, with integers read as BigInts whatever the database's setting, and the app's statements unchanged", () => {
  const db = new DatabaseSync(":memory:", { readBigInts: true, returnArrays: true });
  db.exec("create table t (id integer primary key, n integer, r real, b blob, doc text, flag integer, x); insert into t values (1, 5, 1.5, x'0102', '{\"a\":1}', 1, 7), (2, 9007199254740993, null, null, null, 0, null), (3, 1, null, null, null, 2, null)");
  const fixtureQuery: QueryModule<"sqlite"> = { columns: [["id", "int"], ["n", "int"], ["r", "float"], ["b", "bytes"], ["doc", "json"], ["flag", "bool"], ["x", "unknown"]], dialect: "sqlite", params: ["id"], sql: "select id, n, r, b, doc, flag, x from t where id = :id" };
  const [row] = nativeRows(db, fixtureQuery, { id: 1 });
  // A plain object, as on every other driver: node:sqlite's own rows have a null prototype.
  assert.deepEqual(row, { b: Uint8Array.of(1, 2), doc: { a: 1 }, flag: true, id: 1, n: 5, r: 1.5, x: 7 });
  // The failing control: the app's own statement keeps its database's settings.
  assert.deepEqual(db.prepare("select n from t where id = 1").get(), [BigInt("5")]);
  assert.throws(() => nativeRows(db, fixtureQuery, { id: 2 }), (candidate: unknown) => candidate instanceof DecodeError && candidate instanceof TypeError && candidate.message.startsWith('Column "n" holds 9007199254740993'));
  // A boolean column holding 2, which SQLite lets in: refused, naming it.
  assert.throws(() => nativeRows(db, fixtureQuery, { id: 3 }), /^TypeError: Column "flag" is a boolean, stored as 0 or 1, and holds 2/u);
  // A query defined by hand: integers exact, nothing else known.
  const [bare] = nativeRows(db, { dialect: "sqlite", params: [], sql: "select n, doc from t where id = 1" });
  assert.deepEqual(bare, { doc: '{"a":1}', n: 5 });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: the asynchronous drivers' rows normalized: libSQL's BigInt, string and ArrayBuffer, D1's array, a rounded integer refused", async () => {
  const fixtureQuery: QueryModule<"sqlite"> = { columns: [["n", "int"], ["b", "bytes"], ["doc", "json"]], dialect: "sqlite", params: [], sql: "select n, b, doc from t" };
  const blob = Uint8Array.of(1);
  const client = libsql([{ b: blob.buffer, doc: "[1]", n: BigInt("5") }]);
  assert.deepEqual(await execute(client, fixtureQuery), [{ b: blob, doc: [1], n: 5 }]);
  assert.deepEqual(await execute(libsql([{ b: SQL_NULL, doc: SQL_NULL, n: "5" }]), fixtureQuery), [{ b: SQL_NULL, doc: SQL_NULL, n: 5 }], "intMode: string");
  const rounded = d1Fixture([{ b: [1, 2], doc: "{}", n: 9_007_199_254_740_992 }]);
  await assert.rejects(driverPromise(execute(rounded, fixtureQuery)), /Column "n" holds an integer past .* already rounded/u);
  const exact = d1Fixture([{ b: [1, 2], doc: "{}", n: 1 }]);
  assert.deepEqual(await execute(exact, fixtureQuery), [{ b: Uint8Array.of(1, 2), doc: {}, n: 1 }]);
});

const checkLooseAsyncDrivers = async function (): Promise<void> {
  // The drivers that read integers as numbers or strings: libSQL's digits are its INTEGER, any other text in a number's column is refused, and so is D1's BLOB in a string's.
  const ints: QueryModule<"sqlite"> = { columns: [["n", "int"], ["big", "int8"], ["b", "bytes"]], dialect: "sqlite", params: [], sql: "select n, big, b from loose" };
  assert.deepEqual(await execute(libsql([{ b: SQL_NULL, big: "9007199254740993", n: "5" }]), ints), [{ b: SQL_NULL, big: BigInt("9007199254740993"), n: 5 }], "intMode: string");
  const blob = Uint8Array.of(1).buffer;
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ b: SQL_NULL, big: SQL_NULL, n: "abc" }, /Column "n" is typed number and holds the text "abc"/u],
    [{ b: SQL_NULL, big: 1.5, n: 5 }, /Column "big" is typed bigint and holds the number 1.5/u],
    [{ b: SQL_NULL, big: SQL_NULL, n: blob }, /Column "n" is typed number and holds a BLOB of 1 byte/u],
    [{ b: "5", big: SQL_NULL, n: SQL_NULL }, /Column "b" is typed Uint8Array and holds the text "5"/u],
  ];
  await forEachFixtureInOrder(cases, async ([row, pattern]) => {
    const result = execute(libsql([row]), ints);
    await assert.rejects(driverPromise(result), pattern);
  });
  const d1 = d1Fixture([{ s: [1, 2] }]);
  await assert.rejects(driverPromise(execute(d1, { columns: [["s", "text"]], dialect: "sqlite", params: [], sql: "select s from loose" })), /Column "s" is typed string and holds a BLOB of 2 bytes/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a value its column's type does not allow, which a table that is not STRICT stores, refused naming the column; a NUMERIC's text, an untyped column's BLOB and an INTEGER column's REAL kept", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`create table loose (id integer primary key, n integer, r real, s text, b blob, big bigint, z numeric, x);
    insert into loose values (1, 1.5, 2, 'hi', x'01', 9007199254740993, 'abc', x'02'), (2, 'abc', null, null, null, null, null, null), (3, x'0102', null, null, null, null, null, null),
      (4, null, 'xyz', null, null, null, null, null), (5, null, null, x'0203', null, null, null, null), (6, null, null, null, 'plain', null, null, null), (7, null, null, null, 5, null, null, null),
      (8, null, null, null, null, 1.5, null, null), (9, null, null, null, null, 'x', null, null), (10, null, null, null, null, null, x'01', null)`);
  const fixtureQuery: QueryModule<"sqlite"> = { columns: [["n", "int"], ["r", "float"], ["s", "text"], ["b", "bytes"], ["big", "int8"], ["z", "int|float|text"], ["x", "unknown"]], dialect: "sqlite", params: ["id"], sql: "select n, r, s, b, big, z, x from loose where id = :id" };
  assert.deepEqual(execute(db, fixtureQuery, { id: 1 }), [{ b: Uint8Array.of(1), big: BigInt("9007199254740993"), n: 1.5, r: 2, s: "hi", x: Uint8Array.of(2), z: "abc" }]);
  const refusals: [number, RegExp][] = [
    [2, /^TypeError: Column "n" is typed number and holds the text "abc": outside a STRICT table SQLite stores a value of any type in any column.* Replace the value, or read what the column holds with cast\(n as text\)\.$/u],
    [3, /^TypeError: Column "n" is typed number and holds a BLOB of 2 bytes/u],
    [4, /^TypeError: Column "r" is typed number and holds the text "xyz"/u],
    [5, /^TypeError: Column "s" is typed string and holds a BLOB of 2 bytes/u],
    [6, /^TypeError: Column "b" is typed Uint8Array and holds the text "plain"/u],
    [7, /^TypeError: Column "b" is typed Uint8Array and holds the number 5/u],
    [8, /^TypeError: Column "big" is typed bigint and holds the number 1.5: .* Replace the value, or read what the column holds with cast\(big as text\)\.$/u],
    [9, /^TypeError: Column "big" is typed bigint and holds the text "x"/u],
    [10, /^TypeError: Column "z" is typed number \| string and holds a BLOB of 1 byte:/u],
  ];
  Iterator.from(refusals).forEach(([id, refused]) => {assert.throws(() => nativeRows(db, fixtureQuery, { id }), (candidate: unknown) => candidate instanceof DecodeError && refused.test(String(candidate)), `row ${id}`);});
  await checkLooseAsyncDrivers();
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("runSync refuses a client whose prepared statement answers through a promise, which run awaits", async () => {
  const db = { prepare: () => ({ all: promiseDriverStub(() => [{ n: 1 }]) }) };
  const fixtureQuery: QueryModule<"sqlite"> = { columns: [["n", "int"]], dialect: "sqlite", params: [], sql: "select 1 as n" };
  assert.deepEqual(await executeFixture(db, fixtureQuery), [{ n: 1 }]);
  assert.throws(() => executeSyncFixture(db, { ...fixtureQuery, sql: "select 2 as n" }), /answered with a promise/u);
});
