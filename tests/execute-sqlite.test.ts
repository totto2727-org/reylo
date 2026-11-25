// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { execute } from '#reylo-source/execute.ts';
import type { QueryModule, Sqlite3Client, SqlitePromiseClient } from '#reylo-source/execute.ts';
import { defineQuery } from "#reylo-source/index.ts";
import { forEachFixtureInOrder, plain, promiseDriverStub, NO_DRIVER_ERROR, NO_ROW, requireFixtureValue } from "./helpers.ts";
import type { EmptyParameters } from "./helpers.ts";
import { asyncDriverMarker, driverMarker, driverPromise, driverRow, executeFixture } from "./driver-fixtures.ts";
import { lite, row } from "./execute-test-fixtures.ts";
import type { Call } from "./execute-test-fixtures.ts";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: node:sqlite answers at once, with one ? per placeholder; a write gives no rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table t (a int)");
  const rows = execute(db, lite, { id: 1, name: "ada" });
  assert.ok(Array.isArray(rows), "a synchronous client's rows are not a promise");
  assert.deepEqual(plain(rows.map((currentRow) => driverRow(currentRow))), [row]);
  assert.deepEqual(execute(db, { dialect: "sqlite", params: ["a"], sql: "insert into t values (:a)" }, { a: 2 }), []);
  assert.deepEqual(plain(db.prepare("select a from t").all()), [{ a: 2 }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: better-sqlite3's statement that returns no rows is run(), since its all() throws", () => {
  const calls: Call[] = [];
  const db = {
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => {
        if (sql.startsWith("insert")) {
          // oxlint-disable-next-line rules/require-tagged-error -- better-sqlite3 throws this native TypeError on all() for a write.
          throw new TypeError("This statement does not return data. Use run() instead");
        }
        calls.push({ args, method: "all" });
        return [row];
      },
      reader: !sql.startsWith("insert"),
      run: (...args: unknown[]) => {
        calls.push({ args, method: "run" });
        return { changes: 1 };
      },
    }),
  };
  assert.deepEqual(execute(db, { dialect: "sqlite", params: ["a"], sql: "insert into t values (:a)" }, { a: 2 }), []);
  assert.deepEqual(execute(db, lite, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(calls, [{ args: [2], method: "run" }, { args: [1, "ada", 1], method: "all" }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Cloudflare D1's prepare(sql).bind(...values).all() → { results }", async () => {
  const bound: unknown[][] = [];
  const d1 = {
    batch: promiseDriverStub(() => []),
    prepare: () => ({ bind: (...values: unknown[]) => {
      bound.push(values);
      return { all: promiseDriverStub(() => ({ meta: {}, results: [row], success: true })) };
    }, first: promiseDriverStub(() => NO_ROW) }),
  };
  const rows = execute(d1, lite, { id: 1, name: "ada" });
  assert.ok(rows instanceof Promise);
  assert.deepEqual(await rows, [row]);
  assert.deepEqual(bound, [[1, "ada", 1]]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: @libsql/client and its transactions take execute({ sql, args }) → { rows }", async () => {
  const calls: unknown[] = [];
  const tx = { commit: asyncDriverMarker, execute: promiseDriverStub((stmt: { sql: string; args: unknown[] }) => {
    calls.push(stmt);
    return { columns: ["id"], rows: [row], rowsAffected: 0 };
  }), executeMultiple: asyncDriverMarker };
  assert.deepEqual(await execute(tx, lite, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(calls, [{ args: [1, "ada", 1], sql: "select ? as id, ? as name, ? as again" }]);
});

interface TursoStatement {
  all: (...values: unknown[]) => Promise<typeof row[]>;
  close: () => void;
  closed: boolean;
  reader: boolean;
  safe: boolean | undefined;
  safeIntegers: (enabled: boolean) => TursoStatement;
}

const tursoStatement = function (sql: string, calls: unknown[]): TursoStatement {
  const statement: TursoStatement = {
    all: promiseDriverStub((...values: unknown[]) => {
      calls.push({ safe: statement.safe, sql, values });
      return [row];
    }),
    close: () => {statement.closed = true;},
    closed: false,
    get reader(): boolean {
      // oxlint-disable-next-line rules/require-tagged-error -- Turso 0.4 exposes this getter and throws its native Error when read.
      throw new Error("not implemented");
    },
    safe: undefined,
    safeIntegers: (enabled) => {
      statement.safe = enabled;
      return statement;
    },
  };
  return statement;
};

const checkTursoCompat = function (calls: unknown[]): void {
  // The compat Database (@tursodatabase/database/compat) has batch() as D1 does, and answers at once.
  // It gets a statement per call, closed after it (0.4's, run a second time, lost a subquery's rows).
  const counts = { closed: 0, prepared: 0 };
  const compat = {
    batch: () => [],
    exec: driverMarker,
    maxWriteReplicationIndex: driverMarker,
    prepare: (sql: string) => {
      counts.prepared += 1;
      return { all: (...values: unknown[]) => {
        calls.push({ sql, values });
        return [row];
      }, close: () => {counts.closed += 1;}, reader: true, safeIntegers: driverMarker };
    },
  };
  const query = defineQuery<{ id: number; name: string }, unknown, "many", "sqlite">({ dialect: "sqlite", params: lite.params, sql: lite.sql });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(query.runSync(compat, { id: 2, name: "bo" }), [row]);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(query.runSync(compat, { id: 2, name: "bo" }), [row]);
  assert.deepEqual(calls.at(-1), { sql: "select ? as id, ? as name, ? as again", values: [2, "bo", 2] });
  assert.deepEqual([counts.prepared, counts.closed], [2, 2]);
};

const checkTursoIntegerMode = async function (v08: { prepare: (sql: string) => TursoStatement }, calls: unknown[]): Promise<void> {
  // A module whose every column is typed reads numbers, as better-sqlite3's statement does.
  await executeFixture(v08, { ...lite, columns: [["id", "int"], ["name", "text"], ["again", "int"]] }, { id: 1, name: "ada" });
  assert.equal(driverRow(calls.at(-1)).safe, false);
  const direct = defineQuery<EmptyParameters, unknown, "many", "sqlite">({ dialect: "sqlite", params: [], sql: "select 1" });
  // @ts-expect-error The asynchronous Turso statement cannot serve runSync.
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This native SQLite API call takes no Effect path.
  assert.throws(() => direct.runSync(v08), /runSync takes a synchronous SQLite client .*answers through a promise/u);
};

const checkTursoAsyncReceivers = async function (clients: unknown[], calls: unknown[], statements: TursoStatement[]): Promise<void> {
  await forEachFixtureInOrder(clients, async (client) => {
    const pending = executeFixture(client, lite, { id: 1, name: "ada" });
    assert.deepEqual(await driverPromise(pending), [row]);
  });
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ safe: true, sql: "select ? as id, ? as name, ? as again", values: [1, "ada", 1] })), "a statement whose columns are not typed reads integers exact");
  assert.ok(statements.every((st) => st.closed), "each statement is closed after its run");
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Turso's @tursodatabase/database, its Database in every release and its Transaction, takes prepare(sql).all(...values) → a promise of rows; its compat Database answers at once", async () => {
  const calls: unknown[] = [];
  const statements: TursoStatement[] = [];
  const prepare = (sql: string): TursoStatement => {
    const statement = tursoStatement(sql, calls);
    statements.push(statement);
    return statement;
  };
  const common = { connect: asyncDriverMarker, exec: asyncDriverMarker, maxWriteReplicationIndex: driverMarker, prepare };
  // 0.4: no all() on the database, so it looked synchronous; 0.6 and later: all() and exec(), so it looked like sqlite3's.
  const v04 = { ...common };
  const v08 = { ...common, all: promiseDriverStub(() => []), batch: promiseDriverStub(() => []), transactionAsync: driverMarker };
  const tx = { all: promiseDriverStub(() => []), batch: promiseDriverStub(() => []), exec: asyncDriverMarker, prepare, run: promiseDriverStub(() => ({})) };
  await checkTursoAsyncReceivers([v04, v08, tx], calls, statements);
  await checkTursoIntegerMode(v08, calls);
  checkTursoCompat(calls);
});

const checkExactSqliteBigInts = async function (
  sqlite3: Sqlite3Client,
  sqlite: SqlitePromiseClient,
  seen: unknown[][],
): Promise<void> {
  // A BIGINT column's parameter (the engine's int8), whose INTEGER affinity reads the digits as that integer.
  const big: QueryModule<"sqlite"> = { ...lite, inputs: { id: { type: { kind: "scalar", name: "int8" } }, name: { type: { kind: "scalar", name: "text" } } } };
  await execute(sqlite3, big, { id: BigInt("9007199254740993"), name: "ada" });
  await execute(sqlite, big, { id: BigInt("-9007199254740993"), name: "ada" });
  assert.deepEqual([...seen].slice(2), [["9007199254740993", "ada", "9007199254740993"], ["-9007199254740993", "ada", "-9007199254740993"]]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: sqlite3 and the sqlite package, which bind a BigInt as NULL, get one a number holds as that number, a larger one its digits where the parameter is a BIGINT column's, and is refused elsewhere", async () => {
  const seen: unknown[][] = [];
  const sqlite3 = { all: (_sql: string, boundValues: unknown[], complete: (error: Error | null, rows: unknown[]) => void) => {
    seen.push(boundValues);
    complete(NO_DRIVER_ERROR, []);
  }, exec: driverMarker };
  const sqlite = { all: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(requireFixtureValue(boundValues));
    return [];
  }), getDatabaseInstance: () => ({}) };
  await execute(sqlite3, lite, { id: BigInt(7), name: "ada" });
  await execute(sqlite, lite, { id: BigInt(-7), name: "ada" });
  assert.deepEqual([...seen], [[7, "ada", 7], [-7, "ada", -7]]);
  await forEachFixtureInOrder([sqlite3, sqlite], async (client) => {
    await assert.rejects(async () => {
      await execute(client, lite, { id: BigInt("9007199254740993"), name: "ada" });
    }, /^TypeError: sqlite3 binds a BigInt as NULL, and 9007199254740993 is past 2\^53 - 1/u);
  });
  assert.equal(seen.length, 2);
  await checkExactSqliteBigInts(sqlite3, sqlite, seen);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: sqlite3's callback all(), its errors, and the sqlite package's promise all()", async () => {
  // oxlint-disable-next-line rules/require-tagged-error -- SQLite3 invokes the callback with this exact native driver error.
  const failure = Object.assign(new Error("SQLITE_ERROR: near \"selec\": syntax error"), { code: "SQLITE_ERROR" });
  const sqlite3 = {
    all: (sql: string, values: unknown[], done: (error: Error | null, rows: unknown[]) => void) => setImmediate(() => {
      if (sql.includes("selec ")) {done(failure, []);}
      else {done(NO_DRIVER_ERROR, [{ values }]);}
    }),
    exec: driverMarker,
    prepare: () => ({}),
  };
  assert.deepEqual(await execute(sqlite3, lite, { id: 1, name: "ada" }), [{ values: [1, "ada", 1] }]);
  await assert.rejects(driverPromise(execute(sqlite3, { dialect: "sqlite", params: [], sql: "selec 1" })), (error) => error === failure);
  const wrapper = { all: promiseDriverStub((_sql: string, values: unknown[]) => [{ values }]), getDatabaseInstance: () => sqlite3, prepare: promiseDriverStub(() => ({})) };
  assert.deepEqual(await execute(wrapper, lite, { id: 2, name: "bo" }), [{ values: [2, "bo", 2] }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Bun.sql's SQLite adapter, which has unsafe() and no prepare()", async () => {
  assert.deepEqual(await execute({ commitDistributed: asyncDriverMarker, unsafe: promiseDriverStub(() => [row]) }, lite, { id: 1, name: "ada" }), [row]);
});
