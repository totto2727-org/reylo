// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs these real driver cases through Node's test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Use native assertions to compare each driver's returned values and errors.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Compare the same query against Node's native SQLite driver.
import { DatabaseSync } from "node:sqlite";
import { forEachFixtureInOrder, SQL_NULL } from "./helpers.ts";
import { built, closeSQLite3, loadDrivers, loadTurso, plain, representationOptions, withLabProject } from "./sqlite-driver-lab-fixture.ts";
import type { LabDrivers, SqliteQuery } from "./sqlite-driver-lab-fixture.ts";

const SCHEMA = `create table t (id integer primary key, n integer not null, r real, s text, b blob, flag boolean, x, z numeric);
    insert into t values (1, 5, 1.5, 'hi', x'0102ff', 1, 7, 2.5), (2, 6, null, null, null, 0, x'01', 'abc');
    create table big (id integer primary key, v integer); insert into big values (1, 9007199254740993);
    create table odd (id integer primary key, ok boolean); insert into odd values (1, 2);
    create table loose (id integer primary key, n integer, s text); insert into loose values (1, 'abc', x'0102');
    create table tight (id integer primary key, n integer not null) strict; insert into tight values (1, 5)`;

const textInN = /Column "n" is typed number and holds the text "abc"/u;
const blobInS = /Column "s" is typed string and holds a BLOB of 2 bytes/u;
// LibSQL's intMode "string" hands the 2 over as its digits.
const refused = /Column "ok" is a boolean, stored as 0 or 1, and holds "?2"?, which is neither/u;
const rows = [
  { b: { bytes: [1, 2, 255] }, flag: true, id: 1, more: false, n: 5, r: 1.5, s: "hi", x: 7, z: 2.5 },
  { b: SQL_NULL, flag: false, id: 2, more: true, n: 6, r: SQL_NULL, s: SQL_NULL, x: { bytes: [1] }, z: "abc" },
];
const bigError = /Column "v" holds .*9007199254740992|Column "v" holds 9007199254740993/u;

interface ScalarQueries {
  allTypes: SqliteQuery;
  big: SqliteQuery;
  looseN: SqliteQuery;
  looseS: SqliteQuery;
  mixed: SqliteQuery;
  odd: SqliteQuery;
}

const queriesFor = async (root: string): Promise<ScalarQueries> => {
  // A column declared BOOLEAN and a comparison are booleans.
  const allTypes = await built(root, "all_types", "select *, n > 5 as more from t order by id");
  const big = await built(root, "big", "select id, v from big");
  const odd = await built(root, "odd", "select ok from odd");
  // A table that is not STRICT stores the text 'abc' in an INTEGER column and a BLOB in a TEXT one.
  const looseN = await built(root, "loose_n", "select n from loose");
  const looseS = await built(root, "loose_s", "select s from loose");
  // A value that is one of several kinds is typed unknown, so nothing is refused over a STRICT table.
  const mixed = await built(root, "mixed", "select n as v from tight union all select 'x'");
  return { allTypes, big, looseN, looseS, mixed, odd };
};

const assertSyncErrors = (db: InstanceType<LabDrivers["BetterSQLite"]>, { big, looseN, looseS, odd }: ScalarQueries): void => {
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => big.runSync(db), bigError);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => odd.runSync(db), refused);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => looseN.runSync(db), textInN);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => looseS.runSync(db), blobInS);
};

const assertPermissiveRows = (db: InstanceType<LabDrivers["BetterSQLite"]>): void => {
  assert.equal(db.prepare("select ok from odd").get().ok, BigInt("2"), "the control: SQLite lets the 2 in");
  assert.equal(db.prepare("select n from loose").get().n, "abc", "the control: SQLite lets the text in");
};

const assertRejectedColumns = async (
  client: Parameters<SqliteQuery["run"]>[0],
  { looseN, looseS, odd }: ScalarQueries,
): Promise<void> => {
  await assert.rejects(odd.run(client), refused);
  await assert.rejects(looseN.run(client), textInN);
  await assert.rejects(looseS.run(client), blobInS);
};

const checkBetterSQLite = (file: string, BetterSQLite: LabDrivers["BetterSQLite"], queries: ScalarQueries): void => {
  const { allTypes, mixed } = queries;
  // Better-sqlite3 with every integer a BigInt: Reylo's statement reads numbers, the app's keep its setting.
  const db = new BetterSQLite(file);
  db.defaultSafeIntegers(true);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(allTypes.runSync(db)), rows, "better-sqlite3 with defaultSafeIntegers(true)");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(db.transaction(() => allTypes.runSync(db))()), rows, "better-sqlite3 in db.transaction");
  assert.equal(typeof db.prepare("select n from t").get().n, "bigint", "the control: the app's own statement");
  assertSyncErrors(db, queries);
  assertPermissiveRows(db);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(mixed.runSync(db)), [{ v: 5 }, { v: "x" }], "better-sqlite3: a STRICT table's union of a number and text");
  db.close();
};

const checkNodeSQLite = async (file: string, queries: ScalarQueries): Promise<void> => {
  const { allTypes, big, mixed } = queries;
  const node = new DatabaseSync(file, { readBigInts: true });
  assert.deepEqual(plain(await allTypes.run(node)), rows, "node:sqlite with readBigInts");
  await assert.rejects(big.run(node), bigError);
  await assertRejectedColumns(node, queries);
  assert.deepEqual(plain(await mixed.run(node)), [{ v: 5 }, { v: "x" }], "node:sqlite: a STRICT table's union of a number and text");
  node.close();
};

const checkLibsql = async (file: string, createClient: LabDrivers["createClient"], queries: ScalarQueries): Promise<void> => {
  const { allTypes } = queries;
  await forEachFixtureInOrder(["number", "bigint", "string"], async (intMode) => {
    const client = createClient({ intMode, url: `file:${file}` });
    // Under intMode "string" an integer in a column with no type is its digits (wiki/driver-decoding.md).
    if (intMode !== "string") {assert.deepEqual(plain(await allTypes.run(client)), rows, `libSQL with intMode ${intMode}`);}
    await assertRejectedColumns(client, queries);
    client.close();
  });
};

const checkTurso = async (file: string, queries: ScalarQueries): Promise<void> => {
  const { allTypes, big } = queries;
  // Turso's new engine on the same file: its promise API through run, in transactionAsync too, and
  // Its compat Database through runSync. At its defaults it rounds an integer past 2^53 silently.
  const { connect, TursoCompat } = await loadTurso();
  await forEachFixtureInOrder([false, true], async (safe) => {
    const tdb = await connect(file);
    tdb.defaultSafeIntegers(safe);
    assert.deepEqual(plain(await allTypes.run(tdb)), rows, `Turso's engine with defaultSafeIntegers(${safe})`);
    const transaction = tdb.transactionAsync(async (client) => allTypes.run(client));
    assert.deepEqual(plain(await transaction()), rows, "Turso's engine in transactionAsync");
    await assert.rejects(big.run(tdb), bigError);
    await assertRejectedColumns(tdb, queries);
    const stored = await tdb.prepare("select v from big").get();
    assert.equal(stored.v, safe ? BigInt("9007199254740993") : 9_007_199_254_740_992, "the control: the app's own statement");
    await tdb.close();
  });
  const compat = new TursoCompat(file);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(allTypes.runSync(compat)), rows, "Turso's compat Database");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(compat.transaction(() => allTypes.runSync(compat))()), rows, "Turso's compat Database in db.transaction");
  assertSyncErrors(compat, queries);
  compat.close();
};

const checkSQLite3 = async (file: string, SQLite3: LabDrivers["SQLite3"], queries: ScalarQueries): Promise<void> => {
  const { allTypes, big } = queries;
  const s3 = new SQLite3(file);
  assert.deepEqual(plain(await allTypes.run(s3)), rows, "sqlite3");
  await assert.rejects(big.run(s3), /Column "v" holds an integer past .* already rounded to 9007199254740992/u);
  await assertRejectedColumns(s3, queries);
  await closeSQLite3(s3);
};

const checkSQLiteWrapper = async (file: string, { open, SQLite3 }: LabDrivers, queries: ScalarQueries): Promise<void> => {
  const { allTypes, looseN, looseS } = queries;
  const wrapper = await open({ driver: SQLite3, filename: file });
  assert.deepEqual(plain(await allTypes.run(wrapper)), rows, "sqlite");
  await assert.rejects(looseN.run(wrapper), textInN);
  await assert.rejects(looseS.run(wrapper), blobInS);
  await wrapper.close();
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: one row on every driver, whatever its integer setting; an integer past 2^53, a BOOLEAN column's 2 and a value its column's type does not allow an error naming its column", representationOptions, async () => {
  const drivers = loadDrivers();
  await withLabProject(SCHEMA, async ({ file, root }) => {
    const queries = await queriesFor(root);
    checkBetterSQLite(file, drivers.BetterSQLite, queries);
    await checkNodeSQLite(file, queries);
    await checkLibsql(file, drivers.createClient, queries);
    await checkTurso(file, queries);
    await checkSQLite3(file, drivers.SQLite3, queries);
    await checkSQLiteWrapper(file, drivers, queries);
  });
});
