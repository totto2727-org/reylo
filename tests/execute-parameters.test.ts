// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { execute } from '#reylo-source/execute.ts';
import type { QueryModule } from '#reylo-source/execute.ts';
import { defineQuery } from "#reylo-source/index.ts";
import { forEachFixtureInOrder, promiseDriverStub, NO_ROW, SQL_NULL } from "./helpers.ts";
import { driverPromise, driverRows, executeFixture } from "./driver-fixtures.ts";
import { pg, lite, row } from "./execute-test-fixtures.ts";

const POSITIONAL = {
  mysql: { dialect: "mysql", params: ["1", "2"], sql: "select ? as id, ? as name" },
  postgres: { dialect: "postgres", params: ["1", "2"], sql: "select $2::text as name, $1::int as id" },
  sqlite: { dialect: "sqlite", params: ["1", "2"], sql: "select ?1 as id, ?2 as name, ?1 as again" },
} satisfies Record<string, QueryModule>;

const checkMapperOrder = async function (): Promise<void> {
  // The mapper's rewritten statement binds by `order`, which names params.
  const unsafe: unknown[][] = [];
  await execute({ unsafe: promiseDriverStub((_sql: string, values: unknown[]) => {
    unsafe.push(values);
    return [];
  }) }, { ...pg, order: ["name", "id", "name"], text: "select $1, $2, $1" }, { id: 1, name: "ada" });
  assert.deepEqual(unsafe, [["ada", 1, "ada"]]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("positional placeholders take an object keyed by number, bound by number on every dialect", async () => {
  const seen: [string, unknown[]][] = [];
  const pgClient = { query: promiseDriverStub((text: string, values: unknown[]) => {
    seen.push([text, values]);
    return { rows: [] };
  }) };
  const mysqlPool = { execute: promiseDriverStub((options: { sql: string }, values: unknown[]) => {
    seen.push([options.sql, values]);
    return [[], []] as [unknown, unknown];
  }), query: promiseDriverStub(() => [[], []] as [unknown, unknown]) };
  const d1 = { batch: promiseDriverStub(() => []), prepare: (text: string) => ({ bind: (...values: unknown[]) => {
    seen.push([text, values]);
    return { all: promiseDriverStub(() => ({ results: [] })) };
  }, first: promiseDriverStub(() => NO_ROW) }) };
  await forEachFixtureInOrder([[pgClient, "postgres"], [mysqlPool, "mysql"], [d1, "sqlite"]] as const, async ([client, dialect]) => {
    await executeFixture(client, POSITIONAL[dialect], { 1: 1, 2: "ada" });
  });
  assert.deepEqual(seen, [
    ["select $2::text as name, $1::int as id", [1, "ada"]],
    ["select ? as id, ? as name", [1, "ada"]],
    ["select ? as id, ? as name, ? as again", [1, "ada", 1]],
  ]);
  await checkMapperOrder();
});

const NAMED_ERROR = /^TypeError: The parameters must be an object keyed by parameter name, or by number for positional placeholders \(\{ 1: \.\.\., 2: \.\.\. \}\); got an array\. This statement takes \{ id: \.\.\., name: \.\.\. \}\.$/u;
const refused = (pattern: RegExp): ((candidate: unknown) => boolean) =>
  (candidate) => candidate instanceof TypeError && pattern.test(String(candidate));

const POSTGRES_POSITIONAL: QueryModule<"postgres"> = { dialect: "postgres", params: ["1", "2"], sql: "select $1::int, $2::text" };

interface ParameterClient {
  unsafe: (...args: unknown[]) => Promise<unknown[]>;
}

const checkAsyncParameterShapes = async function (client: ParameterClient): Promise<void> {
  // A freshness check would be a round trip: the array is refused before it too.
  await assert.rejects(driverPromise(executeFixture(client, { ...pg, fresh: { inserts: [], query: "select 1", rows: [] } }, [1, "ada"])), refused(NAMED_ERROR));
  await assert.rejects(driverPromise(executeFixture(client, POSTGRES_POSITIONAL, [1, "ada"])), refused(/got an array\. This statement takes \{ 1: \.\.\., 2: \.\.\. \}\.$/u));
  await assert.rejects(driverPromise(executeFixture(client, pg, "ada")), refused(/positional placeholders \(\{ 1: \.\.\., 2: \.\.\. \}\); got ada\. This statement takes \{ id: \.\.\., name: \.\.\. \}\.$/u));
  await assert.rejects(driverPromise(executeFixture(client, pg, SQL_NULL)), refused(/got null\./u));
};

const nativeFixtureRows = (database: DatabaseSync, query: QueryModule<"sqlite">, params: unknown): unknown[] =>
  driverRows(executeFixture(database, query, params));

const checkSyncParameterShapes = function (database: DatabaseSync): void {
  assert.throws(() => nativeFixtureRows(database, lite, [1, "ada"]), refused(NAMED_ERROR));
  assert.throws(() => nativeFixtureRows(database, { dialect: "sqlite", params: [], sql: "select 1" }, []), refused(/got an array\. This statement takes none: leave them out\.$/u));
};

const checkPublicParameterTypes = async function (database: DatabaseSync, client: ParameterClient): Promise<void> {
  // Through the query object: run and with reject, runSync throws, and the types refuse it too.
  const currentQuery = defineQuery<{ id: number; name: string }, { id: number; name: string; again: number }, "one", "sqlite">({ cardinality: "one", dialect: "sqlite", params: lite.params, sql: lite.sql });
  // @ts-expect-error the parameters are an object, never an array
  await assert.rejects(currentQuery.run(database, [1, "ada"]), refused(NAMED_ERROR));
  // @ts-expect-error the parameters are an object, never an array
  await assert.rejects(currentQuery.with(database)([1, "ada"]), refused(NAMED_ERROR));
  // @ts-expect-error the parameters are an object, never an array
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => currentQuery.runSync(database, [1, "ada"]), refused(NAMED_ERROR));
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual({ ...currentQuery.runSync(database, { id: 1, name: "ada" }) }, row);
  const positionalQuery = defineQuery<{ 1: number; 2: string }, { id: number }, "one", "postgres">({ cardinality: "one", dialect: "postgres", params: POSTGRES_POSITIONAL.params, sql: POSTGRES_POSITIONAL.sql });
  // @ts-expect-error positional placeholders take an object keyed by number
  await assert.rejects(positionalQuery.run(client, [1, "ada"]), refused(/This statement takes \{ 1: \.\.\., 2: \.\.\. \}\./u));
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an array of parameters is refused before anything runs, with a TypeError that says to pass an object", async () => {
  const calls: unknown[] = [];
  const client = { unsafe: promiseDriverStub((...args: unknown[]) => {
    calls.push(args);
    return [];
  }) };
  await checkAsyncParameterShapes(client);
  assert.deepEqual(calls, []);
  const database = new DatabaseSync(":memory:");
  try {
    checkSyncParameterShapes(database);
    await checkPublicParameterTypes(database, client);
  } finally {
    database.close();
  }
});
