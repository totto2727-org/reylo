// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs these real driver cases through Node's test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Use native assertions to compare each driver's returned values and errors.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Compare the same query against Node's native SQLite driver.
import { DatabaseSync } from "node:sqlite";
import { forEachFixtureInOrder, requireFixtureValue, SQL_NULL } from "./helpers.ts";
import { built, closeSQLite3, loadDrivers, loadTurso, plain, representationOptions, withLabProject } from "./sqlite-driver-lab-fixture.ts";
import type { LabDrivers, SqliteQuery } from "./sqlite-driver-lab-fixture.ts";

const SCHEMA = `create table acct (id integer primary key, n integer not null, v bigint, w Int8);
    insert into acct values (1, 5, 9007199254740993, 7), (2, 6, 5, null)`;

const LARGE = BigInt("9007199254740993");
const SMALL = BigInt("5");
const ROUNDED = 9_007_199_254_740_992;
const exactRows = [
  { id: 1, most: LARGE, n: 5, v: LARGE, w: BigInt("7") },
  { id: 2, most: SMALL, n: 6, v: SMALL, w: SQL_NULL },
];
// SQLite computes v + 0 as an integer with a number type, so the first row is out of range.
const plusError = /Column "plus" holds 9007199254740993, an integer past/u;
const rounded = /Column "v" is a 64-bit integer, and the driver already rounded its value to 9007199254740992/u;

interface Queries {
  all: SqliteQuery;
  byV: SqliteQuery;
  exact: SqliteQuery;
}

const queriesFor = async (root: string): Promise<Queries> => {
  const all = await built(root, "acct_all", "select id, n, v, w, max(v, 0) as most, v + 0 as plus from acct group by id order by id");
  const byV = await built(root, "acct_by_v", "select id, v from acct where v = :v");
  const exact = await built(root, "acct_exact", "select id, n, v, w, max(v, 0) as most from acct order by id");
  return { all, byV, exact };
};

const checkBetterSQLite = (file: string, BetterSQLite: LabDrivers["BetterSQLite"], { all, byV, exact }: Queries): void => {
  // Better-sqlite3 at its default, every integer a number: Reylo's statement reads the BIGINT
  // Column exact, and the INTEGER column as a number, whatever the database says.
  Iterator.from([false, true]).forEach((safe) => {
    const db = new BetterSQLite(file);
    db.defaultSafeIntegers(safe);
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    assert.deepEqual(plain(exact.runSync(db)), exactRows, `better-sqlite3 with defaultSafeIntegers(${safe})`);
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    assert.throws(() => all.runSync(db), plusError);
    const own = db.prepare("select n, v from acct where id = 1").get();
    assert.deepEqual(own, safe ? { n: SMALL, v: LARGE } : { n: 5, v: ROUNDED }, "the control: the app's own statement keeps its setting, and rounds v without safeIntegers");
    // What `run` returns goes back in.
    const row = requireFixtureValue(exactRows[0]);
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    assert.deepEqual(plain(byV.runSync(db, { v: row.v })), [{ id: 1, v: LARGE }], "better-sqlite3: the BIGINT's value as a parameter");
    db.close();
  });
};

const checkNodeSQLite = async (file: string, { all, byV, exact }: Queries): Promise<void> => {
  await forEachFixtureInOrder([false, true], async (readBigInts) => {
    const node = new DatabaseSync(file, { readBigInts });
    assert.deepEqual(plain(await exact.run(node)), exactRows, `node:sqlite with readBigInts ${readBigInts}`);
    await assert.rejects(all.run(node), plusError);
    assert.deepEqual(plain(await byV.run(node, { v: LARGE })), [{ id: 1, v: LARGE }], "node:sqlite: the BIGINT's value as a parameter");
    node.close();
  });
};

const checkLibsql = async (file: string, createClient: LabDrivers["createClient"], { byV, exact }: Queries): Promise<void> => {
  await forEachFixtureInOrder(["number", "bigint", "string"], async (intMode) => {
    const client = createClient({ intMode, url: `file:${file}` });
    // At its default intMode libSQL refuses an integer past 2^53 itself, before Reylo sees it.
    if (intMode === "number") {await assert.rejects(exact.run(client), RangeError);}
    else {assert.deepEqual(plain(await exact.run(client)), exactRows, `libSQL with intMode ${intMode}`);}
    assert.deepEqual(plain(await byV.run(client, { v: SMALL })), [{ id: 2, v: SMALL }], `libSQL with intMode ${intMode}: a BIGINT within 2^53`);
    if (intMode !== "number") {assert.deepEqual(plain(await byV.run(client, { v: LARGE })), [{ id: 1, v: LARGE }], `libSQL with intMode ${intMode}: the BIGINT's value as a parameter`);}
    client.close();
  });
};

const checkTurso = async (file: string, { byV, exact }: Queries): Promise<void> => {
  const { connect, TursoCompat } = await loadTurso();
  await forEachFixtureInOrder([false, true], async (safe) => {
    const tdb = await connect(file);
    tdb.defaultSafeIntegers(safe);
    assert.deepEqual(plain(await exact.run(tdb)), exactRows, `Turso's engine with defaultSafeIntegers(${safe})`);
    assert.deepEqual(plain(await byV.run(tdb, { v: LARGE })), [{ id: 1, v: LARGE }], "Turso's engine: the BIGINT's value as a parameter");
    const stored = await tdb.prepare("select v from acct where id = 1").get();
    assert.equal(stored.v, safe ? LARGE : ROUNDED, "the control: the app's own statement");
    await tdb.close();
  });
  const compat = new TursoCompat(file);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(exact.runSync(compat)), exactRows, "Turso's compat Database");
  compat.close();
};

const checkWrappers = async (file: string, { open, SQLite3 }: LabDrivers, { byV, exact }: Queries): Promise<void> => {
  // Sqlite3 and sqlite round past 2^53 before Reylo sees the value: refused, naming the column; a
  // Value within it is a BigInt, and goes back in (a larger one is refused before the statement runs).
  const s3 = new SQLite3(file);
  await assert.rejects(exact.run(s3), rounded);
  assert.deepEqual(plain(await byV.run(s3, { v: SMALL })), [{ id: 2, v: SMALL }], "sqlite3: a BIGINT within 2^53, as a parameter and back");
  await closeSQLite3(s3);
  const wrapper = await open({ driver: SQLite3, filename: file });
  await assert.rejects(exact.run(wrapper), rounded);
  assert.deepEqual(plain(await byV.run(wrapper, { v: SMALL })), [{ id: 2, v: SMALL }], "sqlite: a BIGINT within 2^53");
  await wrapper.close();
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a column declared BIGINT or INT8 is a BigInt on every driver, exact past 2^53 or refused where the driver rounded it, an INTEGER a number; its value goes back in as a parameter", representationOptions, async () => {
  const drivers = loadDrivers();
  await withLabProject(SCHEMA, async ({ file, root }) => {
    const queries = await queriesFor(root);
    checkBetterSQLite(file, drivers.BetterSQLite, queries);
    await checkNodeSQLite(file, queries);
    await checkLibsql(file, drivers.createClient, queries);
    await checkTurso(file, queries);
    await checkWrappers(file, drivers, queries);
  });
});
