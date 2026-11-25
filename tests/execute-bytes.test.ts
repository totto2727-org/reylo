// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { execute } from '#reylo-source/execute.ts';
import type { PgQueryClient, QueryModule } from '#reylo-source/execute.ts';
import { forEachFixtureInOrder, promiseDriverStub, NO_DRIVER_ERROR, SQL_NULL, requireFixtureValue } from "./helpers.ts";
import { driverMarker, executeFixture } from "./driver-fixtures.ts";
import { binary, bin } from "./execute-test-fixtures.ts";

const checkMariaBytes = function (seen: unknown[], api: string, data: ReturnType<typeof binary> & { buf: Buffer }): void {
  const [plainBytes, viewBytes, existingBuffer, itemCount] = seen;
  assert.ok(Buffer.isBuffer(plainBytes) && Buffer.isBuffer(viewBytes), api);
  assert.deepEqual([...plainBytes], [1, 2, 255]);
  assert.deepEqual([...viewBytes], [1, 2, 255]);
  // Both conversions share the original memory and offset.
  assert.ok(plainBytes.buffer === data.plain.buffer && viewBytes.buffer === data.view.buffer && viewBytes.byteOffset === 1);
  assert.equal(existingBuffer, data.buf);
  assert.equal(itemCount, 1);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: mariadb, which writes a value that is not a Buffer as JSON, gets a binary value as a Buffer over the same memory", async () => {
  const { plain, view } = binary();
  const buf = Buffer.from([1, 2, 255]);
  await forEachFixtureInOrder(["promise", "callback"], async (api) => {
    const seen: unknown[][] = [];
    const conn =
      api === "promise"
        ? { batch: promiseDriverStub(() => ({})), query: promiseDriverStub((_sql: string, values: unknown[]) => {
          seen.push(values);
          return [];
        }) }
        : { batch: () => ({}), query: (_sql: string, values: unknown[], done: (error: Error | null, rows?: unknown) => void) => {
          seen.push(values);
          setImmediate(() => {done(NO_DRIVER_ERROR, []);});
          return { on: driverMarker };
        } };
    await executeFixture(conn, bin, { buf, n: 1, plain, view });
    checkMariaBytes(requireFixtureValue(seen[0]), api, { buf, plain, view });
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: Neon's neon() before 0.10, which sends a Buffer as JSON, gets a binary value in Postgres's hex form", async () => {
  const { plain, view } = binary();
  const seen: unknown[][] = [];
  const sql = promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values));
    return [];
  });
  const fixtureQuery: QueryModule<"postgres"> = { dialect: "postgres", params: ["plain", "view", "buf", "empty", "n"], sql: "select :plain::bytea, :view::bytea, :buf::bytea, :empty::bytea, :n" };
  await execute(sql, fixtureQuery, { buf: Buffer.from([0, 16, 171]), empty: new Uint8Array(0), n: 1, plain, view });
  assert.deepEqual(seen[0], [String.raw`\x0102ff`, String.raw`\x0102ff`, String.raw`\x0010ab`, String.raw`\x`, 1]);
});

const checkPostgresBinary = async function (plain: Uint8Array, seen: unknown[]): Promise<void> {
  const pgq: QueryModule<"postgres"> = { dialect: "postgres", params: ["b"], sql: "select :b::bytea" };
  const pgp = { manyOrNone: promiseDriverStub(() => []), query: promiseDriverStub((config: { values: unknown[] }) => {
    seen.push(config.values[0]);
    return [];
  }) };
  await executeFixture(pgp, pgq, { b: plain });
  await execute({ query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values)[0]);
    return { rows: [] };
  }) }, pgq, { b: plain });
  await execute({ unsafe: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values)[0]);
    return [];
  }) }, pgq, { b: plain });
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("every other driver gets a binary value as it is, pg-promise included, since it binds a { text, values } object", async () => {
  const { plain } = binary();
  const seen: unknown[] = [];
  await checkPostgresBinary(plain, seen);
  const liteq: QueryModule<"sqlite"> = { dialect: "sqlite", params: ["b"], sql: "select :b" };
  await execute({ execute: promiseDriverStub((_statement: unknown, values?: unknown[]) => {
    seen.push(requireFixtureValue(values)[0]);
    return [[], []] as [unknown, unknown];
  }), query: promiseDriverStub(() => [[], []] as [unknown, unknown]) }, { ...bin, params: ["b"], sql: "select hex(:b)" }, { b: plain });
  await execute({ prepare: () => ({ all: (...values: unknown[]) => {
    seen.push(values[0]);
    return [];
  } }) }, liteq, { b: plain });
  assert.equal(seen.length, 5);
  Iterator.from(seen).forEach((boundValue) => {assert.equal(boundValue, plain);});
});

const bytes = (name: string): { type: { kind: "scalar"; name: string } } => ({ type: { kind: "scalar" as const, name } });
const BINARY_POSTGRES: QueryModule<"postgres"> = { dialect: "postgres", inputs: { b: bytes("bytea"), bs: { type: { kind: "array", of: bytes("bytea").type } } }, params: ["b", "bs"], sql: "select :b::bytea, :bs::bytea[]" };

const checkRefused = async function (run: () => Promise<void>, expected: RegExp): Promise<void> {
  await assert.rejects(run, (candidate: unknown) => candidate instanceof TypeError && expected.test(candidate.message));
};

const checkOtherBinaryInputs = async function (): Promise<void> {
  // MySQL's BINARY, VARBINARY and BLOB use bytea. SQLite's BLOB uses blob.
  const mysql: QueryModule<"mysql"> = { dialect: "mysql", inputs: { b: bytes("bytea") }, params: ["b"], sql: "select :b" };
  const mysqlClient = { execute: promiseDriverStub(() => [[], []] as [unknown, unknown]), query: promiseDriverStub(() => [[], []] as [unknown, unknown]) };
  await checkRefused(async () => {await execute(mysqlClient, mysql, { b: "AQL/" });}, /^Parameter "b" is binary data/u);
  const sqlite: QueryModule<"sqlite"> = { dialect: "sqlite", inputs: { b: bytes("blob") }, params: ["b"], sql: "select :b" };
  await checkRefused(async () => {await execute({ prepare: () => ({ all: () => [] }) }, sqlite, { b: "AQL/" });}, /^Parameter "b" is binary data/u);
};

const checkPostgresRefusals = async function (client: PgQueryClient, plain: Uint8Array): Promise<void> {
  await checkRefused(async () => {await execute(client, BINARY_POSTGRES, { b: "AQL/", bs: [] });}, /^Parameter "b" is binary data, so it takes a Uint8Array \(a Buffer is one\), as `\.run\(\)` returns one; got "AQL\/"\. Decode base64 or hex text into one first\.$/u);
  await checkRefused(async () => {await execute(client, BINARY_POSTGRES, { b: plain, bs: [plain, String.raw`\x01`] });}, /^Parameter "bs" is binary data, .*got "\\\\x01"/u);
  await checkRefused(async () => {await execute(client, BINARY_POSTGRES, { b: plain.buffer, bs: [] });}, /^Parameter "b" is binary data, .*got an object\. Wrap an ArrayBuffer in one: new Uint8Array\(buffer\)\.$/u);

};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a binary parameter takes binary data alone, so base64 text is refused before the statement runs", async () => {
  const { plain } = binary();
  const seen: unknown[][] = [];
  const client = { query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values));
    return { rows: [] };
  }) };
  await execute(client, BINARY_POSTGRES, { b: Buffer.from([1]), bs: [plain] });
  await execute(client, BINARY_POSTGRES, { b: SQL_NULL, bs: SQL_NULL });
  assert.equal(seen.length, 2);
  await checkPostgresRefusals(client, plain);
  assert.equal(seen.length, 2);
  await checkOtherBinaryInputs();
});
