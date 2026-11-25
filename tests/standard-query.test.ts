// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { defineQuery } from "#reylo-source/index.ts";
import { matchesBigInt, matchesNull, matchesNumber, matchesString } from "#reylo-source/native-predicates.ts";
import { ParameterError } from "#reylo-source/values.ts";
import { SQL_NULL, NO_ROW } from "./helpers.ts";
import type { EmptyParameters } from "./helpers.ts";
import { driverRows } from "./driver-fixtures.ts";
import { built, withProject } from "./sqlite-project-fixture.ts";
import type { SqliteProjectFixture } from "./sqlite-project-fixture.ts";

// Every import is a Standard Query: `~standard.query` holds the statement, its database, and the
// Two mappings a driver calls, `encode` (the input to the values it binds, each in the database's
// Raw form) and `decode` (the rows it read raw to the output), with `.run()`'s input and output.


const users = defineQuery<{ id: number; tags: number[]; doc: unknown; bytes: Uint8Array; flag: boolean }, { id: number; at: string; big: bigint }, "many", "postgres">({
  cardinality: "many",
  columns: [
    ["id", "int"],
    ["at", "timestamptz"],
    ["big", "int8"],
  ],
  dialect: "postgres",
  inputs: {
    bytes: { type: { kind: "scalar", name: "bytea" } },
    doc: { type: { kind: "json" } },
    flag: { type: { kind: "scalar", name: "bool" } },
    id: { nullable: false, type: { kind: "scalar", name: "int4" } },
    tags: { type: { kind: "array", of: { kind: "scalar", name: "int4" } } },
  },
  order: ["id", "tags", "doc", "bytes", "flag"],
  params: ["id", "tags", "doc", "bytes", "flag"],
  sql: "select id, at, big from users where id = :id and tags @> :tags and doc @> :doc and bytes = :bytes and flag = :flag",
  text: "select id, at, big from users where id = $1 and tags @> $2 and doc @> $3 and bytes = $4 and flag = $5",
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: the statement, its database, and each value as the text the server reads", () => {
  const currentQuery = users["~standard"].query;
  assert.equal(currentQuery.dialect, "postgres");
  assert.equal(currentQuery.text, users.sql);
  assert.deepEqual(currentQuery.encode({ bytes: new Uint8Array([0, 255]), doc: { a: [1] }, flag: true, id: 7, tags: [1, 2] }), ["7", '{"1","2"}', '{"a":[1]}', String.raw`\x00ff`, "t"]);
  // A key left out binds NULL, as `.run()` binds it; one the statement takes no null for is refused.
  assert.deepEqual(users["~standard"].query.encode({ id: 7 }), ["7", SQL_NULL, SQL_NULL, SQL_NULL, SQL_NULL]);
  assert.throws(() => currentQuery.encode({ tags: [1] }), (candidate: unknown) => candidate instanceof ParameterError && /"id" is missing/u.test(candidate.message));
  // The input is an object, as `.run()` takes it.
  assert.throws(() => currentQuery.encode([7]), ParameterError);
  // A driver may take `encode` off the object.
  // oxlint-disable-next-line typescript/unbound-method -- The driver must be able to call this callback without a receiver.
  const { encode } = currentQuery;
  assert.deepEqual(encode({ id: 7 }), ["7", SQL_NULL, SQL_NULL, SQL_NULL, SQL_NULL]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: decode gives each value its kind, and the output its cardinality, as .run() does", () => {
  const currentQuery = users["~standard"].query;
  assert.deepEqual(currentQuery.decode([["1", "2026-10-22 14:46:00.123456+02", "9007199254740993"], ["2", "2026-10-22 00:00:00+00", SQL_NULL]]), [
    { at: "2026-10-22T12:46:00.123456Z", big: BigInt("9007199254740993"), id: 1 },
    { at: "2026-10-22T00:00:00Z", big: SQL_NULL, id: 2 },
  ]);
  assert.throws(() => currentQuery.decode([["1", "x"]]), /selects 3 columns, and a row has 2/u);
  const one = defineQuery<EmptyParameters, { n: bigint }, "maybeOne", "postgres">({ cardinality: "maybeOne", columns: [["n", "int8"]], dialect: "postgres", params: [], sql: "select count(*) as n from users" });
  assert.deepEqual(one["~standard"].query.decode([["3"]]), { n: BigInt("3") });
  assert.equal(one["~standard"].query.decode([]), NO_ROW);
  assert.throws(() => one["~standard"].query.decode([["1"], ["2"]]), /Expected at most one row, got 2/u);
  const none = defineQuery<EmptyParameters, never, "none", "postgres">({ cardinality: "none", columns: [], dialect: "postgres", params: [], sql: "delete from users" });
  // oxlint-disable-next-line typescript/no-confusing-void-expression -- Verify the runtime return for the standard's void output cardinality.
  assert.equal(none["~standard"].query.decode([]), undefined);
});

const checkMysqlStandardQuery = function (): void {
  const my = defineQuery<{ id: bigint; doc: unknown }, { id: bigint; at: string; amount: string; ok: boolean }, "maybeOne", "mysql">({
    cardinality: "maybeOne",
    columns: [
      ["id", "int8"],
      ["at", "timestamp"],
      ["amount", "decimal"],
      ["ok", "bool"],
    ],
    dialect: "mysql",
    inputs: { doc: { type: { kind: "json" } }, id: { type: { kind: "scalar", name: "int8" } } },
    order: ["id", "doc"],
    params: ["id", "doc"],
    sql: "select id, at, amount, ok from t where id = :id and json_contains(doc, :doc)",
    text: "select id, at, amount, ok from t where id = ? and json_contains(doc, ?)",
  });
  assert.deepEqual(my["~standard"].query.encode({ doc: { a: 1 }, id: BigInt("5") }), [BigInt("5"), '{"a":1}']);
  // Mysql2's binary protocol gives a BIGINT as its digits, mariadb's text protocol as a BigInt.
  assert.deepEqual(my["~standard"].query.decode([["9007199254740993", "2026-10-22 14:46:00.000000", "1.50", 1]]), { amount: "1.50", at: "2026-10-22T14:46:00.000000", id: BigInt("9007199254740993"), ok: true });
  assert.deepEqual(my["~standard"].query.decode([[BigInt("9007199254740993"), "2026-10-22 14:46:00", "1.50", "1"]]), { amount: "1.50", at: "2026-10-22T14:46:00", id: BigInt("9007199254740993"), ok: true });
  // A column that may be a DATETIME takes the T too, as `.run()` gives it.
  const either = defineQuery<EmptyParameters, { at: string }, "many", "mysql">({ columns: [["at", "timestamp|date"]], dialect: "mysql", params: [], sql: "select coalesce(at, d) as at from t" });
  assert.deepEqual(either["~standard"].query.decode([["2026-10-22 14:46:00"]]), [{ at: "2026-10-22T14:46:00" }]);
};

const checkSqliteStandardQuery = function (): void {
  const lite = defineQuery<{ ok: boolean }, { id: bigint; ok: boolean }, "many", "sqlite">({
    columns: [
      ["id", "int8"],
      ["ok", "bool"],
    ],
    dialect: "sqlite",
    inputs: { ok: { type: { kind: "scalar", name: "bool" } } },
    order: ["ok"],
    params: ["ok"],
    sql: "select id, ok from t where ok = :ok",
    text: "select id, ok from t where ok = ?",
  });
  assert.deepEqual(lite["~standard"].query.encode({ ok: true }), [1]);
  assert.deepEqual(lite["~standard"].query.decode([[BigInt("1"), BigInt("0")]]), [{ id: BigInt("1"), ok: false }]);

  // SQLite decodes through `.run()`'s own normalizing: a value of a storage class the column's type
  // Does not allow, which a table that is not STRICT stores, is refused, and an integer in a column
  // With no type is a number however the driver read it.
  const loose = defineQuery<EmptyParameters, { n: number; s: string; u: unknown }, "many", "sqlite">({
    columns: [
      ["n", "int"],
      ["s", "text"],
      ["u", "unknown"],
    ],
    dialect: "sqlite",
    params: [],
    sql: "select n, s, u from loose",
  });
  const lq = loose["~standard"].query;
  assert.deepEqual(lq.decode([[BigInt("1"), "a", BigInt("2")]]), [{ n: 1, s: "a", u: 2 }]);
  assert.throws(() => lq.decode([["abc", "a", SQL_NULL]]), /Column "n" is typed number and holds the text "abc"/u);
  assert.throws(() => lq.decode([[1, new Uint8Array([1]), SQL_NULL]]), /Column "s" is typed string and holds a BLOB of 1 byte/u);
  assert.throws(() => lq.decode([[BigInt("2") ** BigInt("60"), "a", SQL_NULL]]), /"n"/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql and sqlite: each value as a driver binds it, and decode takes every form a driver reads", () => {
  checkMysqlStandardQuery();
  checkSqliteStandardQuery();
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a query defined by hand without its columns cannot decode, and says so", () => {
  const bare = defineQuery<{ id: number }, { id: number }, "many", "postgres">({ dialect: "postgres", params: ["id"], sql: "select :id::int as id" });
  assert.equal(bare["~standard"].query.text, "select $1::int as id");
  assert.deepEqual(bare["~standard"].query.encode({ id: 1 }), ["1"]);
  assert.throws(() => bare["~standard"].query.decode([["1"]]), /without its columns/u);
});


const SCHEMA = `create table t (id integer primary key, name text not null, ok boolean not null, big bigint, data blob);
insert into t values (1, 'ada', 1, 9007199254740993, x'00ff'), (2, 'bob', 0, null, null);`;
const LIST = "select id, name, ok, big, data from t where ok = :ok or id > :min order by id";

// oxlint-disable-next-line typescript/explicit-function-return-type -- Infer each raw value's narrowed type from the native SQLite result.
const isRawSqliteValue = (value: unknown) =>
  matchesNull(value) || matchesNumber(value) || matchesBigInt(value) || matchesString(value) || value instanceof Uint8Array;

const rawSqliteRow = (value: unknown): (null | number | bigint | string | Uint8Array)[] => {
  const row = driverRows(value);
  assert.ok(row.every((column) => isRawSqliteValue(column)));
  return row;
};

const checkBuiltStandardQuery = async function ({ root, database }: SqliteProjectFixture): Promise<void> {
  const query = await built(root, "list", LIST);
  const standard = query["~standard"].query;
  const statement = database.prepare(standard.text);
  statement.setReturnArrays(true);
  statement.setReadBigInts(true);
  const input = { min: 1, ok: true };
  const raw = statement.all(...standard.encode(input));
  const output = standard.decode(raw.map((row) => rawSqliteRow(row)));
  assert.deepEqual(output, await query.run(database, input));
  assert.deepEqual(output, [
    { big: BigInt("9007199254740993"), data: new Uint8Array([0, 255]), id: 1, name: "ada", ok: true },
    { big: SQL_NULL, data: SQL_NULL, id: 2, name: "bob", ok: false },
  ]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: node:sqlite runs a built import as a Standard Query, with its own conversions off, to .run()'s output", async () => {
  await withProject(SCHEMA, checkBuiltStandardQuery);
});
