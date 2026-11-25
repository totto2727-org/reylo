// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { execute } from '#reylo-source/execute.ts';
import { hasObjectType, isRecord, matchesNullish, matchesString } from "#reylo-source/native-predicates.ts";
import { promiseDriverStub, NO_DRIVER_ERROR, SQL_NULL, requireFixtureValue } from "./helpers.ts";
import { asyncDriverMarker, driverMarker, driverPromise, driverRow, executeFixture } from "./driver-fixtures.ts";
import { my, row } from "./execute-test-fixtures.ts";
import type { Call } from "./execute-test-fixtures.ts";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: execute() → [rows, fields] on mysql2, a repeated name repeated in the values; a write's OK packet gives no rows", async () => {
  const calls: Call[] = [];
  const answers: [unknown, unknown][] = [[[row], [{ name: "id" }]], [{ affectedRows: 1, insertId: 7 }, undefined]];
  const pool = { execute: promiseDriverStub((...args: unknown[]) => {
    calls.push({ args, method: "execute" });
    return requireFixtureValue(answers.shift());
  }), query: promiseDriverStub(() => [[], []] as [unknown, unknown]) };
  assert.deepEqual(await execute(pool, my, { id: 1, name: "ada" }), [row]);
  // The statement with Reylo's per-query options and typeCast (src/decode-mysql.ts), never decimalNumbers.
  const [option, values] = requireFixtureValue(calls[0]).args;
  const options = driverRow(option);
  assert.deepEqual(values, [1, "ada", 1]);
  assert.deepEqual({ ...options, typeCast: typeof options.typeCast }, { bigNumberStrings: true, dateStrings: true, nestTables: false, rowsAsArray: false, sql: "select ? as id, ? as name, ? as again", supportBigNumbers: true, typeCast: "function" });
  assert.deepEqual(await execute(pool, my, { id: 1, name: "ada" }), []);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: PlanetScale's execute() → { rows }", async () => {
  const conn = { execute: promiseDriverStub(() => ({ headers: ["id"], insertId: "0", rows: [row], statement: "select" })) };
  assert.deepEqual(await execute(conn, my, { id: 1, name: "ada" }), [row]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: mariadb runs through query(), not its own execute(); a write's OK packet gives no rows", async () => {
  const calls: string[] = [];
  const answers: unknown[] = [Object.assign([row], { meta: [] }), { affectedRows: 1, insertId: BigInt("7"), warningStatus: 0 }];
  const conn = {
    batch: promiseDriverStub(() => {
      calls.push("batch");
      return {};
    }),
    execute: promiseDriverStub(() => {
      calls.push("execute");
      return [row];
    }),
    query: promiseDriverStub(() => {
      calls.push("query");
      return answers.shift();
    }),
  };
  assert.deepEqual([...(await execute(conn, my, { id: 1, name: "ada" }))], [row]);
  assert.deepEqual(await execute(conn, my, { id: 1, name: "ada" }), []);
  assert.deepEqual(calls, ["query", "query"]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: mariadb's callback API answers through the callback, and its errors reject", async () => {
  // oxlint-disable-next-line rules/require-tagged-error -- MariaDB calls back with a native Error bearing its driver code.
  const failure = Object.assign(new Error("Duplicate entry 'a' for key 'email'"), { code: "ER_DUP_ENTRY" });
  const conn = {
    batch: () => ({}),
    // The callback query() returns a command object, not a promise.
    query: (options: { sql: string }, values: unknown[], done: (error: Error | null, rows?: unknown) => void) => {
      setImmediate(() => {
        if (options.sql.startsWith("insert")) {done(failure);}
        else {done(NO_DRIVER_ERROR, [{ values }]);}
      });
      return { on: driverMarker };
    },
  };
  assert.deepEqual(await executeFixture(conn, my, { id: 1, name: "ada" }), [{ values: [1, "ada", 1] }]);
  await assert.rejects(driverPromise(executeFixture(conn, { dialect: "mysql", params: ["a"], sql: "insert into t values (:a)" }, { a: 1 })), (error) => error === failure);
});

const refusedParameters = (candidate: unknown): boolean => {
  if (!(candidate instanceof TypeError) || !/2\.0 binds no parameters/u.test(candidate.message)) {return false;}
  const { cause } = candidate;
  return isRecord(cause) && matchesString(cause.message) && /not supported/u.test(cause.message);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: PlanetScale 2.0, which binds no parameters, runs a statement without any and refuses one with some", async () => {
  const calls: unknown[][] = [];
  // 2.0's execute(query, options) refuses anything past them, or a second argument that is not its options.
  const conn = {
    execute: promiseDriverStub((...args: unknown[]) => {
      calls.push(args);
      if (args.length > 2 || (!matchesNullish(args[1]) && (!hasObjectType(args[1]) || Array.isArray(args[1])))) {
        // oxlint-disable-next-line rules/require-tagged-error -- The driver throws its own error for the unsupported argument shape.
        throw new Error("Query parameters are not supported: pass a complete SQL string and options to execute(query, options)");
      }
      return { headers: [], rows: [row], statement: String(args[0]) };
    }),
  };
  assert.deepEqual(await execute(conn, { dialect: "mysql", params: [], sql: "select 1" }), [row]);
  await assert.rejects(driverPromise(execute(conn, my, { id: 1, name: "ada" })), refusedParameters);
  // 1.x's form first, then 2.0's, with Reylo's cast either way.
  assert.deepEqual(requireFixtureValue(calls[0]).slice(0, 2), ["select 1", SQL_NULL]);
  const [text, options] = requireFixtureValue(calls[1]);
  assert.deepEqual([text, Object.keys(driverRow(options))], ["select 1", ["as", "cast"]]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: a mysql2 callback pool or connection runs through its promise() wrapper", async () => {
  const callback = {
    // The callback execute() returns a Query object, not a promise.
    execute: () => ({ on: driverMarker }),
    promise: () => ({ execute: promiseDriverStub(() => [[row], []] as [unknown, unknown]), query: promiseDriverStub(() => [[], []] as [unknown, unknown]) }),
  };
  assert.deepEqual(await execute(callback, my, { id: 1, name: "ada" }), [row]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: Bun.sql's unsafe()", async () => {
  assert.deepEqual(await execute({ commitDistributed: asyncDriverMarker, unsafe: promiseDriverStub(() => [row]) }, my, { id: 1, name: "ada" }), [row]);
});
