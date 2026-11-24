// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to inspect or write files through the host filesystem.
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to await writes and reads through the host filesystem.
import { writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to use the host resolver for the installed driver or fixture package.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import { join } from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to convert local module URLs with the host platform's path rules.
import { pathToFileURL } from "node:url";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { Session } from "#reylo-source/analyze.ts";
import { sqlModule } from "#reylo-source/loader.ts";
import { renderType } from "#reylo-source/render.ts";
import { hasFunctionType, isRecord } from "#reylo-source/native-predicates.ts";
import type { LibsqlClient, Sqlite3Client, SqlitePromiseClient, SyncSqliteClient, TursoClient } from "#reylo-source/execute.ts";
import type { Cardinality, Query } from "#reylo-source/index.ts";
import { DRIVERS, forEachFixtureInOrder, INDEX } from "./helpers.ts";

// Real SQLite drivers must return the same public value representation.
const drivers = existsSync(join(DRIVERS, "better-sqlite3")) || "lab/drivers is not installed";
const require = createRequire(join(DRIVERS, "package.json"));

type QueryParams = Record<string, unknown>;
type SqliteQuery = Pick<Query<QueryParams, unknown, Cardinality, "sqlite">, "run" | "runSync">;
type TestStatement = ReturnType<SyncSqliteClient["prepare"]> & {
  get: () => Record<string, unknown>;
};
interface TestSyncClient {
  close: () => void;
  defaultSafeIntegers: (enabled: boolean) => unknown;
  prepare: (sql: string) => TestStatement;
  transaction: <Result>(callback: () => Result) => () => Result;
}
type TestLibsqlClient = LibsqlClient & { close: () => void };
type TestSqlite3 = Sqlite3Client & { close: (callback: (error?: Error | null) => void) => void };
type TestSqlite = SqlitePromiseClient & { close: () => Promise<void> };
type TestTurso = Omit<TursoClient, "prepare"> & {
  close: () => Promise<void>;
  defaultSafeIntegers: (enabled: boolean) => unknown;
  prepare: (sql: string) => { all: (...params: unknown[]) => Promise<unknown[]>; get: () => Promise<Record<string, unknown>> };
  transactionAsync: <Result>(callback: (transaction: TursoClient) => Promise<Result>) => () => Promise<Result>;
};
interface LibsqlAdapter { createClient: (options: { intMode: string; url: string }) => TestLibsqlClient }
interface Sqlite3Adapter { Database: new (file: string) => TestSqlite3 }
interface SqliteAdapter { open: (options: { driver: Sqlite3Adapter["Database"]; filename: string }) => Promise<TestSqlite> }
type SyncAdapter = new (file: string) => TestSyncClient;
interface TursoAdapter { connect: (file: string) => Promise<TestTurso> }

const driverAdapter = <Module>(value: unknown): Module =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The optional driver lab installs the real packages whose tested interfaces are declared here.
  value as Module;

const loadDriver = <Module>(name: string): Module => driverAdapter<Module>(require(name));

const importDriver = async <Module>(name: string): Promise<Module> =>
  driverAdapter<Module>(await import(pathToFileURL(require.resolve(name)).href));

const project = function (...linked: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "reylo-representation-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "node_modules"));
  Iterator.from(linked).forEach((driver) => {symlinkSync(join(DRIVERS, driver), join(root, "node_modules", driver));});
  return root;
};

/** The module a build step writes for `sql`, imported. */
const built = async function (root: string, url: string, name: string, sql: string): Promise<SqliteQuery> {
  const file = join(root, `${name}.sql`);
  await writeFile(file, sql);
  await writeFile(join(root, ".env"), `DATABASE_URL=${url}\n`);
  try {
    const { code } = await sqlModule(file, sql);
    const out = join(root, `${name}.mjs`);
    await writeFile(out, code.replace(`from "@totto2727/reylo"`, `from ${JSON.stringify(INDEX)}`));
    const imported: unknown = await import(pathToFileURL(out).href);
    assert.ok(isRecord(imported), "generated SQLite module exports a query");
    const { default: query } = imported;
    assert.ok(isRecord(query) && hasFunctionType(query.run) && hasFunctionType(query.runSync), "generated query has native run and runSync");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The generated query has both methods and this fixture only compiles SQLite statements.
    return query as SqliteQuery;
  } finally {
    await forEachFixtureInOrder(Session.opened(), async (session) => {await session.close();});
  }
};

/** Rows compared by value: a driver's own row prototype and a Buffer's are not Reylo's to set. No value Reylo returns is a Date. */
const plain = (v: unknown): unknown => {
  if (v instanceof Date) {throw new assert.AssertionError({ message: `a Date in Reylo's rows: ${v.toISOString()}` });}
  return v instanceof Uint8Array ? { bytes: [...v] } : Array.isArray(v) ? v.map(plain) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([key, value]) => [key, plain(value)])) : v;
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: one row on every driver, whatever its integer setting; an integer past 2^53, a BOOLEAN column's 2 and a value its column's type does not allow an error naming its column", { skip: drivers === true ? false : drivers, timeout: 60_000 }, async () => {
  const Database = loadDriver<SyncAdapter>("better-sqlite3");
  const { createClient } = loadDriver<LibsqlAdapter>("@libsql/client");
  const sqlite3 = loadDriver<Sqlite3Adapter>("sqlite3");
  const { open } = loadDriver<SqliteAdapter>("sqlite");
  const root = project();
  const file = join(root, "app.db");
  const setup = new DatabaseSync(file);
  setup.exec(`create table t (id integer primary key, n integer not null, r real, s text, b blob, flag boolean, x, z numeric);
    insert into t values (1, 5, 1.5, 'hi', x'0102ff', 1, 7, 2.5), (2, 6, null, null, null, 0, x'01', 'abc');
    create table big (id integer primary key, v integer); insert into big values (1, 9007199254740993);
    create table odd (id integer primary key, ok boolean); insert into odd values (1, 2);
    create table loose (id integer primary key, n integer, s text); insert into loose values (1, 'abc', x'0102');
    create table tight (id integer primary key, n integer not null) strict; insert into tight values (1, 5)`);
  setup.close();
  // A column declared BOOLEAN and a comparison are booleans.
  const q = await built(root, "file:./app.db", "all_types", "select *, n > 5 as more from t order by id");
  const big = await built(root, "file:./app.db", "big", "select id, v from big");
  const odd = await built(root, "file:./app.db", "odd", "select ok from odd");
  // A table that is not STRICT stores the text 'abc' in an INTEGER column and a BLOB in a TEXT one.
  const looseN = await built(root, "file:./app.db", "loose_n", "select n from loose");
  const looseS = await built(root, "file:./app.db", "loose_s", "select s from loose");
  const textInN = /Column "n" is typed number and holds the text "abc"/u;
  const blobInS = /Column "s" is typed string and holds a BLOB of 2 bytes/u;
  // A value that is one of several kinds is typed unknown, so nothing is refused over a STRICT table.
  const mixed = await built(root, "file:./app.db", "mixed", "select n as v from tight union all select 'x'");
  // LibSQL's intMode "string" hands the 2 over as its digits.
  const refused = /Column "ok" is a boolean, stored as 0 or 1, and holds "?2"?, which is neither/u;
  const rows = [
    { b: { bytes: [1, 2, 255] }, flag: true, id: 1, more: false, n: 5, r: 1.5, s: "hi", x: 7, z: 2.5 },
    { b: null, flag: false, id: 2, more: true, n: 6, r: null, s: null, x: { bytes: [1] }, z: "abc" },
  ];
  const bigError = /Column "v" holds .*9007199254740992|Column "v" holds 9007199254740993/;
  // Better-sqlite3 with every integer a BigInt: Reylo's statement reads numbers, the app's keep its setting.
  const db = new Database(file);
  db.defaultSafeIntegers(true);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(q.runSync(db)), rows, "better-sqlite3 with defaultSafeIntegers(true)");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(db.transaction(() => q.runSync(db))()), rows, "better-sqlite3 in db.transaction");
  assert.equal(typeof db.prepare("select n from t").get().n, "bigint", "the control: the app's own statement");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => big.runSync(db), bigError);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => odd.runSync(db), refused);
  assert.equal(db.prepare("select ok from odd").get().ok, BigInt("2"), "the control: SQLite lets the 2 in");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => looseN.runSync(db), textInN);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => looseS.runSync(db), blobInS);
  assert.equal(db.prepare("select n from loose").get().n, "abc", "the control: SQLite lets the text in");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(mixed.runSync(db)), [{ v: 5 }, { v: "x" }], "better-sqlite3: a STRICT table's union of a number and text");
  db.close();
  const node = new DatabaseSync(file, { readBigInts: true });
  assert.deepEqual(plain(await q.run(node)), rows, "node:sqlite with readBigInts");
  await assert.rejects(big.run(node), bigError);
  await assert.rejects(odd.run(node), refused);
  await assert.rejects(looseN.run(node), textInN);
  await assert.rejects(looseS.run(node), blobInS);
  assert.deepEqual(plain(await mixed.run(node)), [{ v: 5 }, { v: "x" }], "node:sqlite: a STRICT table's union of a number and text");
  node.close();
  await forEachFixtureInOrder(["number", "bigint", "string"], async (intMode) => {
    const client = createClient({ url: `file:${file}`, intMode });
    // Under intMode "string" an integer in a column with no type is its digits (wiki/driver-decoding.md).
    if (intMode !== "string") {assert.deepEqual(plain(await q.run(client)), rows, `libSQL with intMode ${intMode}`);}
    await assert.rejects(odd.run(client), refused);
    await assert.rejects(looseN.run(client), textInN);
    await assert.rejects(looseS.run(client), blobInS);
    client.close();
  });
  // Turso's new engine on the same file: its promise API through run, in transactionAsync too, and
  // Its compat Database through runSync. At its defaults it rounds an integer past 2^53 silently.
  const turso = await importDriver<TursoAdapter>("@tursodatabase/database");
  const { Database: TursoCompat } = await importDriver<{ Database: SyncAdapter }>("@tursodatabase/database/compat");
  await forEachFixtureInOrder([false, true], async (safe) => {
    const tdb = await turso.connect(file);
    tdb.defaultSafeIntegers(safe);
    assert.deepEqual(plain(await q.run(tdb)), rows, `Turso's engine with defaultSafeIntegers(${safe})`);
    assert.deepEqual(plain(await tdb.transactionAsync((transaction) => q.run(transaction))()), rows, "Turso's engine in transactionAsync");
    await assert.rejects(big.run(tdb), bigError);
    await assert.rejects(odd.run(tdb), refused);
    await assert.rejects(looseN.run(tdb), textInN);
    await assert.rejects(looseS.run(tdb), blobInS);
    assert.equal((await tdb.prepare("select v from big").get()).v, safe ? BigInt("9007199254740993") : 9_007_199_254_740_992, "the control: the app's own statement");
    await tdb.close();
  });
  const compat = new TursoCompat(file);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(q.runSync(compat)), rows, "Turso's compat Database");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(compat.transaction(() => q.runSync(compat))()), rows, "Turso's compat Database in db.transaction");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => big.runSync(compat), bigError);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => odd.runSync(compat), refused);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => looseN.runSync(compat), textInN);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => looseS.runSync(compat), blobInS);
  compat.close();
  const s3 = new sqlite3.Database(file);
  assert.deepEqual(plain(await q.run(s3)), rows, "sqlite3");
  await assert.rejects(big.run(s3), /Column "v" holds an integer past .* already rounded to 9007199254740992/);
  await assert.rejects(odd.run(s3), refused);
  await assert.rejects(looseN.run(s3), textInN);
  await assert.rejects(looseS.run(s3), blobInS);
  await new Promise((resolve) => s3.close(resolve));
  const wrapper = await open({ filename: file, driver: sqlite3.Database });
  assert.deepEqual(plain(await q.run(wrapper)), rows, "sqlite");
  await assert.rejects(looseN.run(wrapper), textInN);
  await assert.rejects(looseS.run(wrapper), blobInS);
  await wrapper.close();
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: libSQL's intMode \"string\" changes no value Reylo types a number or a NUMERIC's: an INTEGER is its number, exact up to 2^53 - 1 and refused past it; a column with no type keeps libSQL's digits", { skip: drivers === true ? false : drivers, timeout: 60_000 }, async () => {
  const { createClient } = loadDriver<LibsqlAdapter>("@libsql/client");
  const root = project();
  const file = join(root, "app.db");
  const setup = new DatabaseSync(file);
  // `ok + 0` is a REAL's expression on a column declared BOOLEAN, and what SQLite computes from the
  // Stored 2 is the INTEGER 2; `z` is a NUMERIC column, which stores 7 and 9007199254740991 as
  // INTEGERs and 2.5 and 'abc' as they are; `x` has no type.
  setup.exec(`create table t (id integer primary key, ok boolean, z numeric, x);
    insert into t values (1, 2, 7, 7), (2, 2, 2.5, 'abc'), (3, 2, 'abc', '7'), (4, 2, 9007199254740991, null);
    create table past (id integer primary key, z numeric); insert into past values (1, 9007199254740992)`);
  setup.close();
  const q = await built(root, "file:./app.db", "computed", "select id, ok + 0 as n, ok + 9007199254740989 as edge, z, x from t order by id");
  const over = await built(root, "file:./app.db", "computed_over", "select ok + 9007199254740990 as edge from t where id = 1");
  const past = await built(root, "file:./app.db", "numeric_past", "select z from past");
  await forEachFixtureInOrder(["number", "bigint", "string"], async (intMode) => {
    const client = createClient({ url: `file:${file}`, intMode });
    const digits = intMode === "string";
    assert.deepEqual(
      plain(await q.run(client)),
      [
        // A column with no type cannot tell libSQL's digits from a TEXT's: it keeps what libSQL gives.
        { id: 1, n: 2, edge: 9_007_199_254_740_991, z: 7, x: digits ? "7" : 7 },
        { id: 2, n: 2, edge: 9_007_199_254_740_991, z: 2.5, x: "abc" },
        { id: 3, n: 2, edge: 9_007_199_254_740_991, z: "abc", x: "7" },
        { id: 4, n: 2, edge: 9_007_199_254_740_991, z: 9_007_199_254_740_991, x: null },
      ],
      `libSQL with intMode ${intMode}`,
    );
    // One past 2^53 - 1: libSQL's intMode "number" refuses it itself; the others hand it over exact, and Reylo refuses it.
    const refused = intMode === "number" ? RangeError : /Column "edge" holds 9007199254740992, an integer past/u;
    await assert.rejects(over.run(client), refused, `libSQL with intMode ${intMode}: a REAL's expression past 2^53 - 1`);
    await assert.rejects(past.run(client), intMode === "number" ? RangeError : /Column "z" holds 9007199254740992, an integer past/u, `libSQL with intMode ${intMode}: a NUMERIC past 2^53 - 1`);
    client.close();
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a column declared BIGINT or INT8 is a BigInt on every driver, exact past 2^53 or refused where the driver rounded it, an INTEGER a number; its value goes back in as a parameter", { skip: drivers === true ? false : drivers, timeout: 60_000 }, async () => {
  const Database = loadDriver<SyncAdapter>("better-sqlite3");
  const { createClient } = loadDriver<LibsqlAdapter>("@libsql/client");
  const sqlite3 = loadDriver<Sqlite3Adapter>("sqlite3");
  const { open } = loadDriver<SqliteAdapter>("sqlite");
  const root = project();
  const file = join(root, "app.db");
  const setup = new DatabaseSync(file);
  setup.exec(`create table acct (id integer primary key, n integer not null, v bigint, w Int8);
    insert into acct values (1, 5, 9007199254740993, 7), (2, 6, 5, null)`);
  setup.close();
  const all = await built(root, "file:./app.db", "acct_all", "select id, n, v, w, max(v, 0) as most, v + 0 as plus from acct group by id order by id");
  const byV = await built(root, "file:./app.db", "acct_by_v", "select id, v from acct where v = :v");
  const rows = [
    { id: 1, n: 5, v: BigInt("9007199254740993"), w: BigInt("7"), most: BigInt("9007199254740993"), plus: 9_007_199_254_740_993 },
    { id: 2, n: 6, v: BigInt("5"), w: null, most: BigInt("5"), plus: 5 },
  ];
  // `v + 0` is an integer SQLite computes, a number, so row 1's is refused; the rest of the columns read alone.
  const plusError = /Column "plus" holds 9007199254740993, an integer past/u;
  const exact = await built(root, "file:./app.db", "acct_exact", "select id, n, v, w, max(v, 0) as most from acct order by id");
  const exactRows = rows.map(({ plus: _, ...r }) => r);
  const rounded = /Column "v" is a 64-bit integer, and the driver already rounded its value to 9007199254740992/u;
  // Better-sqlite3 at its default, every integer a number: Reylo's statement reads the BIGINT
  // Column exact, and the INTEGER column as a number, whatever the database says.
  Iterator.from([false, true]).forEach((safe) => {
    const db = new Database(file);
    db.defaultSafeIntegers(safe);
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    assert.deepEqual(plain(exact.runSync(db)), exactRows, `better-sqlite3 with defaultSafeIntegers(${safe})`);
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    assert.throws(() => all.runSync(db), plusError);
    const own = db.prepare("select n, v from acct where id = 1").get();
    assert.deepEqual(own, safe ? { n: BigInt("5"), v: BigInt("9007199254740993") } : { n: 5, v: 9_007_199_254_740_992 }, "the control: the app's own statement keeps its setting, and rounds v without safeIntegers");
    // What `run` returns goes back in.
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    assert.deepEqual(plain(byV.runSync(db, { v: exactRows[0]!.v })), [{ id: 1, v: BigInt("9007199254740993") }], "better-sqlite3: the BIGINT's value as a parameter");
    db.close();
  });
  await forEachFixtureInOrder([false, true], async (readBigInts) => {
    const node = new DatabaseSync(file, { readBigInts });
    assert.deepEqual(plain(await exact.run(node)), exactRows, `node:sqlite with readBigInts ${readBigInts}`);
    await assert.rejects(all.run(node), plusError);
    assert.deepEqual(plain(await byV.run(node, { v: BigInt("9007199254740993") })), [{ id: 1, v: BigInt("9007199254740993") }], "node:sqlite: the BIGINT's value as a parameter");
    node.close();
  });
  await forEachFixtureInOrder(["number", "bigint", "string"], async (intMode) => {
    const client = createClient({ url: `file:${file}`, intMode });
    // At its default intMode libSQL refuses an integer past 2^53 itself, before Reylo sees it.
    if (intMode === "number") {await assert.rejects(exact.run(client), RangeError);}
    else {assert.deepEqual(plain(await exact.run(client)), exactRows, `libSQL with intMode ${intMode}`);}
    assert.deepEqual(plain(await byV.run(client, { v: BigInt("5") })), [{ id: 2, v: BigInt("5") }], `libSQL with intMode ${intMode}: a BIGINT within 2^53`);
    if (intMode !== "number") {assert.deepEqual(plain(await byV.run(client, { v: BigInt("9007199254740993") })), [{ id: 1, v: BigInt("9007199254740993") }], `libSQL with intMode ${intMode}: the BIGINT's value as a parameter`);}
    client.close();
  });
  const turso = await importDriver<TursoAdapter>("@tursodatabase/database");
  const { Database: TursoCompat } = await importDriver<{ Database: SyncAdapter }>("@tursodatabase/database/compat");
  await forEachFixtureInOrder([false, true], async (safe) => {
    const tdb = await turso.connect(file);
    tdb.defaultSafeIntegers(safe);
    assert.deepEqual(plain(await exact.run(tdb)), exactRows, `Turso's engine with defaultSafeIntegers(${safe})`);
    assert.deepEqual(plain(await byV.run(tdb, { v: BigInt("9007199254740993") })), [{ id: 1, v: BigInt("9007199254740993") }], "Turso's engine: the BIGINT's value as a parameter");
    assert.equal((await tdb.prepare("select v from acct where id = 1").get()).v, safe ? BigInt("9007199254740993") : 9_007_199_254_740_992, "the control: the app's own statement");
    await tdb.close();
  });
  const compat = new TursoCompat(file);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(plain(exact.runSync(compat)), exactRows, "Turso's compat Database");
  compat.close();
  // Sqlite3 and sqlite round past 2^53 before Reylo sees the value: refused, naming the column; a
  // Value within it is a BigInt, and goes back in (a larger one is refused before the statement runs).
  const s3 = new sqlite3.Database(file);
  await assert.rejects(exact.run(s3), rounded);
  assert.deepEqual(plain(await byV.run(s3, { v: BigInt("5") })), [{ id: 2, v: BigInt("5") }], "sqlite3: a BIGINT within 2^53, as a parameter and back");
  await new Promise((resolve) => s3.close(resolve));
  const wrapper = await open({ filename: file, driver: sqlite3.Database });
  await assert.rejects(exact.run(wrapper), rounded);
  assert.deepEqual(plain(await byV.run(wrapper, { v: BigInt("5") })), [{ id: 2, v: BigInt("5") }], "sqlite: a BIGINT within 2^53");
  await wrapper.close();
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: JSON a statement builds is the object its type says on every driver, and a text column that holds JSON stays a string", { skip: drivers === true ? false : drivers, timeout: 60_000 }, async () => {
  const Database = loadDriver<SyncAdapter>("better-sqlite3");
  const { createClient } = loadDriver<LibsqlAdapter>("@libsql/client");
  const sqlite3 = loadDriver<Sqlite3Adapter>("sqlite3");
  const { open } = loadDriver<SqliteAdapter>("sqlite");
  const root = project();
  const file = join(root, "app.db");
  const setup = new DatabaseSync(file);
  setup.exec(`create table users (id integer primary key, name text not null, github_id bigint, score real, active boolean not null default 1, doc text);
    create table posts (id integer primary key, user_id integer not null references users (id), title text not null, body text) strict;
    insert into users values (1, 'ann', 9007199254740993, 1.5, 1, '[1]'), (2, 'bob', null, null, 0, null);
    insert into posts values (10, 1, 'hello', null), (11, 1, 'world', 'b')`);
  setup.close();
  const sql = {
    profile: `select json_object(
  'user', json_object('id', u.id, 'name', u.name),
  'posts', json((select json_group_array(json_object('id', p.id, 'title', p.title)) from posts p where p.user_id = u.id))
) as profile
from users u where u.id = :id::int`,
    // A BIGINT inside JSON is a JSON number, which JSON.parse rounds past 2^53, as on Postgres;
    // A truth value is 1 or 0 there, and a BOOLEAN column what it holds.
    values: `select json_object('big', github_id, 'score', score, 'flag', active, 'more', id > 1, 'pair', json_array(name, score), 'doc', doc) as o,
  doc, json_object('n', name) || '' as glued from users order by id`,
  };
  // The types the module declares, as the type check renders them.
  await writeFile(join(root, ".env"), "DATABASE_URL=file:./app.db\n");
  const session = await Session.for(root);
  try {
    const types: Record<string, string> = {};
    await forEachFixtureInOrder(Object.entries(sql), async ([name, text]) => {
      const outcome = await session.analyze(text);
      assert.ok(outcome.ok, `${name}: ${outcome.ok ? "" : outcome.message}`);
      types[name] = outcome.analysis.columns.map((column) => `${column.name}: ${renderType(column.type, false, "sqlite")}${column.nullable ? " | null" : ""}`).join("; ");
    });
    assert.deepEqual(types, {
      profile: "profile: { user: { id: number; name: string }; posts: { id: number; title: string }[] }",
      values: "o: { big: number | null; score: number | null; flag: number | string; more: number; pair: [string, number | null]; doc: string | null }; doc: string | null; glued: string",
    });
  } finally {
    await session.close();
  }
  const profile = await built(root, "file:./app.db", "profile", sql.profile);
  const values = await built(root, "file:./app.db", "values", sql.values);
  const ann = { profile: { posts: [{ id: 10, title: "hello" }, { id: 11, title: "world" }], user: { id: 1, name: "ann" } } };
  const bob = { profile: { posts: [], user: { id: 2, name: "bob" } } };
  const rows = [
    { doc: "[1]", glued: '{"n":"ann"}', o: { big: 9_007_199_254_740_992, doc: "[1]", flag: 1, more: 0, pair: ["ann", 1.5], score: 1.5 } },
    { doc: null, glued: '{"n":"bob"}', o: { big: null, doc: null, flag: 0, more: 1, pair: ["bob", null], score: null } },
  ];
  const check = async (label: string, run: (query: SqliteQuery, params?: QueryParams) => unknown): Promise<void> => {
    assert.deepEqual(plain(await run(profile, { id: 1 })), ann, `${label}: the profile`);
    assert.deepEqual(plain(await run(profile, { id: 2 })), bob, `${label}: a user with no posts`);
    assert.deepEqual(plain(await run(values)), rows, `${label}: the values`);
  };
  await forEachFixtureInOrder([false, true], async (safe) => {
    const db = new Database(file);
    db.defaultSafeIntegers(safe);
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    await check(`better-sqlite3 with defaultSafeIntegers(${safe})`, (q, p) => q.runSync(db, p));
    assert.equal(typeof db.prepare("select json_object('a', 1) as o").get().o, "string", "the control: the app's own statement");
    db.close();
  });
  await forEachFixtureInOrder([false, true], async (readBigInts) => {
    const node = new DatabaseSync(file, { readBigInts });
    await check(`node:sqlite with readBigInts ${readBigInts}`, (q, p) => q.run(node, p));
    node.close();
  });
  await forEachFixtureInOrder(["number", "bigint", "string"], async (intMode) => {
    const client = createClient({ url: `file:${file}`, intMode });
    await check(`libSQL with intMode ${intMode}`, (q, p) => q.run(client, p));
    client.close();
  });
  const turso = await importDriver<TursoAdapter>("@tursodatabase/database");
  const { Database: TursoCompat } = await importDriver<{ Database: SyncAdapter }>("@tursodatabase/database/compat");
  const tdb = await turso.connect(file);
  await check("Turso's engine", (q, p) => q.run(tdb, p));
  await tdb.close();
  const compat = new TursoCompat(file);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  await check("Turso's compat Database", (q, p) => q.runSync(compat, p));
  compat.close();
  const s3 = new sqlite3.Database(file);
  await check("sqlite3", (q, p) => q.run(s3, p));
  await new Promise((resolve) => s3.close(resolve));
  const wrapper = await open({ filename: file, driver: sqlite3.Database });
  await check("sqlite", (q, p) => q.run(wrapper, p));
  await wrapper.close();
});
