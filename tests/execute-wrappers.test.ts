// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The Durable Object adapter forwards native SQLite fixture bindings.
import type { SQLInputValue } from "node:sqlite";
import { defineQuery } from "#reylo-source/index.ts";
import type { Query } from "#reylo-source/index.ts";
import { promiseDriverStub, SQL_NULL } from "./helpers.ts";
import type { EmptyParameters } from "./helpers.ts";
import { asyncDriverMarker, driverMarker, driverPromise, driverRow, executeFixture, executeSyncFixture } from "./driver-fixtures.ts";
import { pg, my, lite, row, durableObjectSql } from "./execute-test-fixtures.ts";

class Kysely {
  #method = driverMarker;

  public selectFrom(): void {this.#method();}
  public executeQuery(): void {this.#method();}
  public transaction(): void {this.#method();}
}

const checkUnsupportedWrappers = async function (): Promise<void> {
  // Kysely and Prisma decode their values themselves, so each is told to pass the driver's client.
  const kysely = new Kysely();
  await assert.rejects(driverPromise(executeFixture(kysely, pg)), /object with selectFrom, executeQuery, transaction\. .* Kysely decodes the values of its queries itself: pass the pool or database its dialect was made with\.$/u);
  await assert.rejects(driverPromise(executeFixture({ $queryRawUnsafe: driverMarker, $transaction: driverMarker }, my)), / Prisma decodes the values of its queries itself: pass a client of your database's driver, such as the pool its driver adapter was made with\.$/u);
  // Inside their transactions, neither hands out the connection.
  const transaction = Object.assign(new Kysely(), { isTransaction: true });
  await assert.rejects(driverPromise(executeFixture(transaction, pg)), / Kysely decodes the values of its queries itself and does not hand out its transaction's connection: take the transaction from the driver's client instead\.$/u);
  await assert.rejects(driverPromise(executeFixture({ $queryRawUnsafe: driverMarker }, lite)), / Prisma decodes the values of its queries itself and does not hand out its transaction's connection/u);
};

const checkTagStore = async function (): Promise<void> {
  // Node:sqlite's tag store has all() for templates; it is not sqlite3's database.
  const database = new DatabaseSync(":memory:");
  try {
    const store = database.createTagStore();
    await assert.rejects(driverPromise(executeFixture(store, lite, { id: 1, name: "ada" })), /sqlite statement on an object with .*pass its database, store\.db/u);
  } finally {
    database.close();
  }
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an unsupported client rejects, naming what it has and what reylo takes", async () => {
  await assert.rejects(driverPromise(executeFixture({ connect: driverMarker, end: driverMarker }, pg)), (candidate: unknown) => candidate instanceof TypeError && /postgres statement on an object with connect, end\. It takes a client with query\(text, values\)/u.test(candidate.message));
  // An object with Drizzle's select() but no session over a client is no Drizzle database.
  await assert.rejects(driverPromise(executeFixture({ $client: {}, select: driverMarker }, pg)), /object with select\. .*or a Drizzle database over one of them\./u);
  await checkUnsupportedWrappers();
  await checkTagStore();
  await assert.rejects(driverPromise(executeFixture(SQL_NULL, my)), /mysql statement on null/u);
  // The refusal names every client a MySQL statement runs on, mariadb's among them.
  await assert.rejects(driverPromise(executeFixture({}, my)), /query\(text, values\) as on mariadb's pool or connection, from its promise or callback API/u);
  // A pg pool handed to a SQLite statement matches no SQLite shape.
  const postgresClient = { query: promiseDriverStub(() => ({ rows: [] })) };
  await assert.rejects(driverPromise(executeFixture(postgresClient, lite)), /sqlite statement on an object with query/u);
});

interface DrizzleFixture<Client> {
  $client: Client;
  execute: typeof driverMarker;
  select: typeof driverMarker;
  session: { client: Client; dialect: object };
}

// Drizzle keeps the native driver client in its session.
const drizzle = <Client>(client: Client): DrizzleFixture<Client> => ({
  $client: client,
  execute: driverMarker,
  select: driverMarker,
  session: { client, dialect: {} },
});

const checkDrizzleSqlite = async function (): Promise<void> {
  const database = new DatabaseSync(":memory:");
  const durableDatabase = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(executeSyncFixture(drizzle(database), lite, { id: 1, name: "ada" }), [row]);
    // Drizzle keeps the Durable Object's storage, ctx.storage, whose SQL storage is its sql.
    const storage = { sql: durableObjectSql(durableDatabase), transactionSync: (fn: () => unknown) => fn() };
    assert.deepEqual(executeSyncFixture(drizzle(storage), lite, { id: 1, name: "ada" }), [row]);
    assert.deepEqual(await executeFixture(drizzle(storage), lite, { id: 1, name: "ada" }), [row]);
  } finally {
    database.close();
    durableDatabase.close();
  }
};

interface LibsqlFixture {
  batch: () => Promise<unknown[]>;
  execute: () => Promise<{ columnTypes: string[]; columns: string[]; rows: object[] }>;
  transaction: typeof asyncDriverMarker;
}

const checkDrizzleTransactions = async function (seen: unknown[][]): Promise<void> {
  // Inside a libSQL transaction the session keeps the base client on client and the transaction on tx.
  const libsql = (name: string): LibsqlFixture => ({ batch: promiseDriverStub(() => []), execute: promiseDriverStub(() => {
    seen.push([name]);
    return { columnTypes: [], columns: ["id", "name", "again"], rows: [row] };
  }), transaction: asyncDriverMarker });
  const tx = { select: driverMarker, session: { client: libsql("base"), dialect: {}, tx: { ...libsql("tx"), commit: asyncDriverMarker, rollback: asyncDriverMarker } } };
  await executeFixture(tx, lite, { id: 1, name: "ada" });
  assert.deepEqual(seen.at(-1), ["tx"]);
  // A MySQL client whose execute() answers without PlanetScale's rows, as TiDB Cloud's transaction inside
  // Drizzle-orm/tidb-serverless answers with the rows themselves, is refused rather than read as no rows.
  const tidb = { $client: {}, rollback: driverMarker, select: driverMarker, session: { client: { execute: promiseDriverStub(() => [row]) }, dialect: {} } };
  await assert.rejects(driverPromise(executeFixture(tidb, my, { id: 1, name: "ada" })), /^TypeError: reylo ran this statement through execute\(\), as on PlanetScale's @planetscale\/database, and the client answered with an array rather than a result with rows\./u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a Drizzle database or transaction runs on the driver client its session keeps", async () => {
  const seen: unknown[][] = [];
  const pgClient = { query: promiseDriverStub((_sql: string, values: unknown[]) => {
    seen.push(values);
    return { rows: [row] };
  }) };
  assert.deepEqual(await executeFixture(drizzle(pgClient), pg, { id: 1, name: "ada" }), [row]);
  const mysqlPool = { execute: promiseDriverStub((_statement: unknown, values: unknown[]) => {
    seen.push(values);
    return [[row], []];
  }), query: promiseDriverStub(() => [[], []]) };
  assert.deepEqual(await executeFixture(drizzle(mysqlPool), my, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(seen, [[1, "ada"], [1, "ada", 1]]);
  await checkDrizzleSqlite();
  await checkDrizzleTransactions(seen);
});

const insert = defineQuery<{ n: bigint; big: bigint; data: Uint8Array; flag: boolean; doc: unknown }, { id: number }, "one", "sqlite">({
  cardinality: "one",
  columns: [["id", "int"]],
  dialect: "sqlite",
  inputs: { big: { type: { kind: "scalar", name: "int8" } } },
  params: ["n", "big", "data", "flag", "doc"],
  sql: "insert into items (n, big, data, flag, doc) values (:n, :big, :data, :flag, :doc) returning id",
});
const select = defineQuery<{ id: number }, unknown, "one", "sqlite">({
  cardinality: "one",
  columns: [["n", "int"], ["big", "int8"], ["data", "bytes"], ["flag", "bool"], ["doc", "json"]],
  dialect: "sqlite",
  params: ["id"],
  sql: "select n, big, data, flag, doc from items where id = :id",
});

const checkDurableWriteBounds = function (sql: ReturnType<typeof durableObjectSql>, db: DatabaseSync): void {
  // A BigInt past 2^53 anywhere else is refused before it reaches exec().
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => insert.runSync(sql, { big: BigInt("1"), data: new Uint8Array(), doc: "1", flag: true, n: BigInt("2") ** BigInt("53") }), /^TypeError: A Durable Object's SQL storage binds no BigInt, and 9007199254740992 is past 2\^53 - 1/u);
  // A write without returning gives no rows.
  const touch = defineQuery<EmptyParameters, unknown, "none", "sqlite">({ cardinality: "none", dialect: "sqlite", params: [], sql: "update items set n = n + 1" });
  // oxlint-disable-next-line rules/no-effect-runtime-run, typescript/no-confusing-void-expression -- The native write takes the SQLite path and must return undefined at runtime.
  assert.equal(touch.runSync(sql), undefined);
  const totals = db.prepare("select sum(n) as s from items").get();
  assert.equal(driverRow(totals).s, 13);
};

const checkDurableRoundTrip = async function (sql: ReturnType<typeof durableObjectSql>): Promise<void> {
  const second = await insert.run(sql, { big: BigInt("7"), data: new Uint8Array([3]), doc: "[]", flag: false, n: BigInt("6") });
  assert.deepEqual(await select.run(sql, second), { big: BigInt("7"), data: new Uint8Array([3]), doc: [], flag: false, n: 6 });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(select.runSync(sql, second), { big: BigInt("7"), data: new Uint8Array([3]), doc: [], flag: false, n: 6 });
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a Durable Object's ctx.storage.sql: runSync and run take it, its values given their kinds", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table items (id integer primary key, n integer, big bigint, data blob, flag boolean, doc json)");
  const sql = durableObjectSql(db);
  // A BigInt a number holds goes as that number; one past 2^53 to a BIGINT column as its digits.
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  const { id } = insert.runSync(sql, { big: BigInt("2") ** BigInt("53") + BigInt("1"), data: new Uint8Array([1, 2]), doc: '{"a":1}', flag: true, n: BigInt("5") });
  assert.equal(id, 1);
  assert.deepEqual({ ...db.prepare("select n, cast(big as text) as big, typeof(big) as t, flag from items").get() }, { big: "9007199254740993", flag: 1, n: 5, t: "integer" });
  // Read back, that BIGINT comes as a rounded number, which Reylo refuses rather than return.
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => select.runSync(sql, { id }), /Column "big" is a 64-bit integer, and the driver already rounded its value/u);
  await checkDurableRoundTrip(sql);
  checkDurableWriteBounds(sql, db);
});

type FreshQuery = (email: string[]) => Query<EmptyParameters, unknown, "many", "sqlite">;

const checkFreshDurableSchema = function (sql: ReturnType<typeof durableObjectSql>, built: FreshQuery): void {
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(built(["users", "email", "TEXT", "1", "0"]).runSync(sql), []);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => built(["users", "email", "TEXT", "0", "0"]).runSync(sql), /^Error: The database changed after users\.sql was built: users\.email was/u);
};

const checkFreshRun = async function (sql: ReturnType<typeof durableObjectSql>, built: FreshQuery, query: string): Promise<void> {
  // Run takes the same synchronous path: the check and the statement run before it returns.
  const ran: string[] = [];
  const counted = { ...sql, databaseSize: 4096, exec: (text: string, ...bindings: SQLInputValue[]) => {
    ran.push(text);
    return sql.exec(text, ...bindings);
  } };
  const pending = built(["users", "email", "TEXT", "1", "0"]).run(counted);
  assert.deepEqual(ran, [query, "select id, email from users"]);
  assert.deepEqual(await pending, []);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a Durable Object's ctx.storage.sql: the catalog facts are read again through exec()", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table users (id integer primary key, email text not null)");
  const sql = durableObjectSql(db);
  const query = "select j.value as fresh_table, p.name as fresh_column, p.type as fresh_type, cast(p.\"notnull\" as text) as fresh_not_null, cast(p.dflt_value is not null or (p.pk > 0 and lower(p.type) = 'integer' and (select count(*) from pragma_table_xinfo(j.value) k where k.pk > 0) = 1) as text) as fresh_default from (select 'users' as value) j, pragma_table_xinfo(j.value) p order by 1, 2";
  const built: FreshQuery = (email: string[]) =>
    defineQuery<EmptyParameters, unknown, "many", "sqlite">({ dialect: "sqlite", fresh: { inserts: [], query, rows: [email, ["users", "id", "INTEGER", "0", "1"]] }, params: [], source: "users.sql", sql: "select id, email from users" });
  checkFreshDurableSchema(sql, built);
  await checkFreshRun(sql, built, query);
});
