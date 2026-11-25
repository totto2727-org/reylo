// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { execute } from '#reylo-source/execute.ts';
import type { QueryModule } from '#reylo-source/execute.ts';
import { promiseDriverStub, requireFixtureValue } from "./helpers.ts";
import { asyncDriverMarker, driverRow, executeFixture } from "./driver-fixtures.ts";
import { hasFunctionType } from "#reylo-source/native-predicates.ts";
import { pg, row } from "./execute-test-fixtures.ts";
import type { Call } from "./execute-test-fixtures.ts";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: query(text, values) → { rows }, as on pg, PGlite and Neon's Pool, with $n numbered once per name", async () => {
  const calls: Call[] = [];
  const client = { query: promiseDriverStub((...args: unknown[]) => {
    calls.push({ args, method: "query" });
    return { rowCount: 1, rows: [row] };
  }) };
  assert.deepEqual(await execute(client, pg, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(calls, [{ args: ["select $1::int as id, $2 as name, $1 as again", [1, "ada"]], method: "query" }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: a query() that resolves to the rows, as Neon's neon() from 1.0 and pg-promise do", async () => {
  const neon = Object.assign(promiseDriverStub(() => {
    assert.fail("The Neon fixture must use its query method");
  }), {
    query: promiseDriverStub(() => [row]),
    // Neon's unsafe() builds a fragment for a template; it must never be taken for a query.
    unsafe: () => ({ sql: "fragment" }),
  });
  assert.deepEqual(await executeFixture(neon, pg, { id: 1, name: "ada" }), [row]);
});

const checkInt8Decoder = function (types: unknown): void {
  const { getTypeParser } = driverRow(types);
  assert.ok(hasFunctionType(getTypeParser));
  const parse: unknown = Reflect.apply(getTypeParser, types, [20]);
  assert.ok(hasFunctionType(parse));
  const result: unknown = Reflect.apply(parse, undefined, ["9007199254740993"]);
  assert.equal(result, BigInt("9007199254740993"));
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: pg-promise gets a { text, values } object, so it binds instead of formatting $1 into the text", async () => {
  const calls: Call[] = [];
  const db = { manyOrNone: promiseDriverStub(() => []), query: promiseDriverStub((...args: unknown[]) => {
    calls.push({ args, method: "query" });
    return [row];
  }) };
  const fixtureQuery: QueryModule<"postgres"> = { dialect: "postgres", params: ["id"], sql: "select '$2' as literal, :id::int as id" };
  assert.deepEqual(await executeFixture(db, fixtureQuery, { id: 1 }), [row]);
  // With Reylo's decoder table, which answers every oid itself.
  const { types, ...bound } = driverRow(requireFixtureValue(calls[0]).args[0]);
  assert.deepEqual(bound, { text: "select '$2' as literal, $1::int as id", values: [1] });
  checkInt8Decoder(types);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: unsafe(text, values) → rows, as on postgres.js and Bun.sql and their transactions; postgres.js is asked to prepare the statement", async () => {
  const calls: Call[] = [];
  const tx = { unsafe: promiseDriverStub((...args: unknown[]) => {
    calls.push({ args, method: "unsafe" });
    return [row];
  }) };
  assert.deepEqual(await execute(tx, pg, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(calls, [{ args: ["select $1::int as id, $2 as name, $1 as again", [1, "ada"], { prepare: true }], method: "unsafe" }]);
  // Bun.sql prepares a statement itself, and takes no options.
  const bunCalls: Call[] = [];
  const bun = { commitDistributed: asyncDriverMarker, unsafe: promiseDriverStub((...args: unknown[]) => {
    bunCalls.push({ args, method: "unsafe" });
    return [row];
  }) };
  assert.deepEqual(await execute(bun, pg, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(bunCalls, [{ args: ["select $1::int as id, $2 as name, $1 as again", [1, "ada"]], method: "unsafe" }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: Neon's neon() before 1.0 is called with (text, values)", async () => {
  const calls: Call[] = [];
  const sql = promiseDriverStub((...args: unknown[]) => {
    calls.push({ args, method: "call" });
    return [row];
  });
  assert.deepEqual(await execute(sql, pg, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(requireFixtureValue(calls[0]).args.slice(0, 2), ["select $1::int as id, $2 as name, $1 as again", [1, "ada"]]);
  // Its options take a decoder table, 0.9 too, and the fields with fullResults.
  const options = driverRow(requireFixtureValue(calls[0]).args[2]);
  assert.deepEqual(Object.keys(options), ["fullResults", "arrayMode", "types"]);
});
