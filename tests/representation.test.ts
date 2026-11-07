import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Session } from "../src/analyze.ts";
import { sqlModule } from "../src/loader.ts";
import { renderType } from "../src/render.ts";
import { defineQuery } from "../src/index.ts";
import { DRIVERS, INDEX } from "./helpers.ts";

// Real SQLite drivers must return the same public value representation.
const drivers = existsSync(join(DRIVERS, "better-sqlite3")) || "lab/drivers is not installed";
const require = createRequire(join(DRIVERS, "package.json"));

function project(...linked: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "reylo-representation-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "node_modules"));
  for (const driver of linked) symlinkSync(join(DRIVERS, driver), join(root, "node_modules", driver));
  return root;
}

/** The module a build step writes for `sql`, imported. */
async function built(root: string, url: string, name: string, sql: string) {
  const file = join(root, `${name}.sql`);
  writeFileSync(file, sql);
  writeFileSync(join(root, ".env"), `DATABASE_URL=${url}\n`);
  try {
    const { code } = await sqlModule(file, sql);
    const out = join(root, `${name}.mjs`);
    writeFileSync(out, code.replace(`from "@totto2727/reylo"`, `from ${JSON.stringify(INDEX)}`));
    return (await import(pathToFileURL(out).href)).default;
  } finally {
    for (const session of Session.opened()) await session.close();
  }
}

/** Rows compared by value: a driver's own row prototype and a Buffer's are not Reylo's to set. No value Reylo returns is a Date. */
const plain = (v: unknown): unknown => {
  if (v instanceof Date) throw new assert.AssertionError({ message: `a Date in Reylo's rows: ${v.toISOString()}` });
  return v instanceof Uint8Array ? { bytes: [...v] } : Array.isArray(v) ? v.map(plain) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
};

test("SQLite: one row on every driver, whatever its integer setting; an integer past 2^53, a BOOLEAN column's 2 and a value its column's type does not allow an error naming its column", { skip: drivers === true ? false : drivers, timeout: 60_000 }, async () => {
  const Database = require("better-sqlite3");
  const { createClient } = require("@libsql/client");
  const sqlite3 = require("sqlite3");
  const { open } = require("sqlite");
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
  const textInN = /Column "n" is typed number and holds the text "abc"/;
  const blobInS = /Column "s" is typed string and holds a BLOB of 2 bytes/;
  // A value that is one of several kinds is typed unknown, so nothing is refused over a STRICT table.
  const mixed = await built(root, "file:./app.db", "mixed", "select n as v from tight union all select 'x'");
  // libSQL's intMode "string" hands the 2 over as its digits.
  const refused = /Column "ok" is a boolean, stored as 0 or 1, and holds "?2"?, which is neither/;
  const rows = [
    { id: 1, n: 5, r: 1.5, s: "hi", b: { bytes: [1, 2, 255] }, flag: true, x: 7, z: 2.5, more: false },
    { id: 2, n: 6, r: null, s: null, b: null, flag: false, x: { bytes: [1] }, z: "abc", more: true },
  ];
  const bigError = /Column "v" holds .*9007199254740992|Column "v" holds 9007199254740993/;
  // better-sqlite3 with every integer a BigInt: Reylo's statement reads numbers, the app's keep its setting.
  const db = new Database(file);
  db.defaultSafeIntegers(true);
  assert.deepEqual(plain(q.runSync(db)), rows, "better-sqlite3 with defaultSafeIntegers(true)");
  assert.deepEqual(plain(db.transaction(() => q.runSync(db))()), rows, "better-sqlite3 in db.transaction");
  assert.equal(typeof db.prepare("select n from t").get().n, "bigint", "the control: the app's own statement");
  assert.throws(() => big.runSync(db), bigError);
  assert.throws(() => odd.runSync(db), refused);
  assert.equal(db.prepare("select ok from odd").get().ok, 2n, "the control: SQLite lets the 2 in");
  assert.throws(() => looseN.runSync(db), textInN);
  assert.throws(() => looseS.runSync(db), blobInS);
  assert.equal(db.prepare("select n from loose").get().n, "abc", "the control: SQLite lets the text in");
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
  for (const intMode of ["number", "bigint", "string"]) {
    const client = createClient({ url: `file:${file}`, intMode });
    // Under intMode "string" an integer in a column with no type is its digits (wiki/driver-decoding.md).
    if (intMode !== "string") assert.deepEqual(plain(await q.run(client)), rows, `libSQL with intMode ${intMode}`);
    await assert.rejects(odd.run(client), refused);
    await assert.rejects(looseN.run(client), textInN);
    await assert.rejects(looseS.run(client), blobInS);
    client.close();
  }
  // Turso's new engine on the same file: its promise API through run, in transactionAsync too, and
  // its compat Database through runSync. At its defaults it rounds an integer past 2^53 silently.
  const turso = await import(pathToFileURL(require.resolve("@tursodatabase/database")).href);
  const { Database: TursoCompat } = await import(pathToFileURL(require.resolve("@tursodatabase/database/compat")).href);
  for (const safe of [false, true]) {
    const tdb = await turso.connect(file);
    tdb.defaultSafeIntegers(safe);
    assert.deepEqual(plain(await q.run(tdb)), rows, `Turso's engine with defaultSafeIntegers(${safe})`);
    assert.deepEqual(plain(await tdb.transactionAsync((tx: unknown) => q.run(tx))()), rows, "Turso's engine in transactionAsync");
    await assert.rejects(big.run(tdb), bigError);
    await assert.rejects(odd.run(tdb), refused);
    await assert.rejects(looseN.run(tdb), textInN);
    await assert.rejects(looseS.run(tdb), blobInS);
    assert.equal((await tdb.prepare("select v from big").get()).v, safe ? 9007199254740993n : 9007199254740992, "the control: the app's own statement");
    await tdb.close();
  }
  const compat = new TursoCompat(file);
  assert.deepEqual(plain(q.runSync(compat)), rows, "Turso's compat Database");
  assert.deepEqual(plain(compat.transaction(() => q.runSync(compat))()), rows, "Turso's compat Database in db.transaction");
  assert.throws(() => big.runSync(compat), bigError);
  assert.throws(() => odd.runSync(compat), refused);
  assert.throws(() => looseN.runSync(compat), textInN);
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

test("SQLite: libSQL's intMode \"string\" changes no value Reylo types a number or a NUMERIC's: an INTEGER is its number, exact up to 2^53 - 1 and refused past it; a column with no type keeps libSQL's digits", { skip: drivers === true ? false : drivers, timeout: 60_000 }, async () => {
  const { createClient } = require("@libsql/client");
  const root = project();
  const file = join(root, "app.db");
  const setup = new DatabaseSync(file);
  // `ok + 0` is a REAL's expression on a column declared BOOLEAN, and what SQLite computes from the
  // stored 2 is the INTEGER 2; `z` is a NUMERIC column, which stores 7 and 9007199254740991 as
  // INTEGERs and 2.5 and 'abc' as they are; `x` has no type.
  setup.exec(`create table t (id integer primary key, ok boolean, z numeric, x);
    insert into t values (1, 2, 7, 7), (2, 2, 2.5, 'abc'), (3, 2, 'abc', '7'), (4, 2, 9007199254740991, null);
    create table past (id integer primary key, z numeric); insert into past values (1, 9007199254740992)`);
  setup.close();
  const q = await built(root, "file:./app.db", "computed", "select id, ok + 0 as n, ok + 9007199254740989 as edge, z, x from t order by id");
  const over = await built(root, "file:./app.db", "computed_over", "select ok + 9007199254740990 as edge from t where id = 1");
  const past = await built(root, "file:./app.db", "numeric_past", "select z from past");
  for (const intMode of ["number", "bigint", "string"]) {
    const client = createClient({ url: `file:${file}`, intMode });
    const digits = intMode === "string";
    assert.deepEqual(
      plain(await q.run(client)),
      [
        // A column with no type cannot tell libSQL's digits from a TEXT's: it keeps what libSQL gives.
        { id: 1, n: 2, edge: 9007199254740991, z: 7, x: digits ? "7" : 7 },
        { id: 2, n: 2, edge: 9007199254740991, z: 2.5, x: "abc" },
        { id: 3, n: 2, edge: 9007199254740991, z: "abc", x: "7" },
        { id: 4, n: 2, edge: 9007199254740991, z: 9007199254740991, x: null },
      ],
      `libSQL with intMode ${intMode}`,
    );
    // One past 2^53 - 1: libSQL's intMode "number" refuses it itself; the others hand it over exact, and Reylo refuses it.
    const refused = intMode === "number" ? RangeError : /Column "edge" holds 9007199254740992, an integer past/;
    await assert.rejects(over.run(client), refused, `libSQL with intMode ${intMode}: a REAL's expression past 2^53 - 1`);
    await assert.rejects(past.run(client), intMode === "number" ? RangeError : /Column "z" holds 9007199254740992, an integer past/, `libSQL with intMode ${intMode}: a NUMERIC past 2^53 - 1`);
    client.close();
  }
});

test("SQLite: a column declared BIGINT or INT8 is a BigInt on every driver, exact past 2^53 or refused where the driver rounded it, an INTEGER a number; its value goes back in as a parameter", { skip: drivers === true ? false : drivers, timeout: 60_000 }, async () => {
  const Database = require("better-sqlite3");
  const { createClient } = require("@libsql/client");
  const sqlite3 = require("sqlite3");
  const { open } = require("sqlite");
  const root = project();
  const file = join(root, "app.db");
  const setup = new DatabaseSync(file);
  setup.exec(`create table acct (id integer primary key, n integer not null, v bigint, w Int8);
    insert into acct values (1, 5, 9007199254740993, 7), (2, 6, 5, null)`);
  setup.close();
  const all = await built(root, "file:./app.db", "acct_all", "select id, n, v, w, max(v, 0) as most, v + 0 as plus from acct group by id order by id");
  const byV = await built(root, "file:./app.db", "acct_by_v", "select id, v from acct where v = :v");
  const rows = [
    { id: 1, n: 5, v: 9007199254740993n, w: 7n, most: 9007199254740993n, plus: 9007199254740993 },
    { id: 2, n: 6, v: 5n, w: null, most: 5n, plus: 5 },
  ];
  // `v + 0` is an integer SQLite computes, a number, so row 1's is refused; the rest of the columns read alone.
  const plusError = /Column "plus" holds 9007199254740993, an integer past/;
  const exact = await built(root, "file:./app.db", "acct_exact", "select id, n, v, w, max(v, 0) as most from acct order by id");
  const exactRows = rows.map(({ plus: _, ...r }) => r);
  const rounded = /Column "v" is a 64-bit integer, and the driver already rounded its value to 9007199254740992/;
  // better-sqlite3 at its default, every integer a number: Reylo's statement reads the BIGINT
  // column exact, and the INTEGER column as a number, whatever the database says.
  for (const safe of [false, true]) {
    const db = new Database(file);
    db.defaultSafeIntegers(safe);
    assert.deepEqual(plain(exact.runSync(db)), exactRows, `better-sqlite3 with defaultSafeIntegers(${safe})`);
    assert.throws(() => all.runSync(db), plusError);
    const own = db.prepare("select n, v from acct where id = 1").get();
    assert.deepEqual(own, safe ? { n: 5n, v: 9007199254740993n } : { n: 5, v: 9007199254740992 }, "the control: the app's own statement keeps its setting, and rounds v without safeIntegers");
    // What `run` returns goes back in.
    assert.deepEqual(plain(byV.runSync(db, { v: exactRows[0]!.v })), [{ id: 1, v: 9007199254740993n }], "better-sqlite3: the BIGINT's value as a parameter");
    db.close();
  }
  for (const readBigInts of [false, true]) {
    const node = new DatabaseSync(file, { readBigInts });
    assert.deepEqual(plain(await exact.run(node)), exactRows, `node:sqlite with readBigInts ${readBigInts}`);
    await assert.rejects(all.run(node), plusError);
    assert.deepEqual(plain(await byV.run(node, { v: 9007199254740993n })), [{ id: 1, v: 9007199254740993n }], "node:sqlite: the BIGINT's value as a parameter");
    node.close();
  }
  for (const intMode of ["number", "bigint", "string"]) {
    const client = createClient({ url: `file:${file}`, intMode });
    // At its default intMode libSQL refuses an integer past 2^53 itself, before Reylo sees it.
    if (intMode === "number") await assert.rejects(exact.run(client), RangeError);
    else assert.deepEqual(plain(await exact.run(client)), exactRows, `libSQL with intMode ${intMode}`);
    assert.deepEqual(plain(await byV.run(client, { v: 5n })), [{ id: 2, v: 5n }], `libSQL with intMode ${intMode}: a BIGINT within 2^53`);
    if (intMode !== "number") assert.deepEqual(plain(await byV.run(client, { v: 9007199254740993n })), [{ id: 1, v: 9007199254740993n }], `libSQL with intMode ${intMode}: the BIGINT's value as a parameter`);
    client.close();
  }
  const turso = await import(pathToFileURL(require.resolve("@tursodatabase/database")).href);
  const { Database: TursoCompat } = await import(pathToFileURL(require.resolve("@tursodatabase/database/compat")).href);
  for (const safe of [false, true]) {
    const tdb = await turso.connect(file);
    tdb.defaultSafeIntegers(safe);
    assert.deepEqual(plain(await exact.run(tdb)), exactRows, `Turso's engine with defaultSafeIntegers(${safe})`);
    assert.deepEqual(plain(await byV.run(tdb, { v: 9007199254740993n })), [{ id: 1, v: 9007199254740993n }], "Turso's engine: the BIGINT's value as a parameter");
    assert.equal((await tdb.prepare("select v from acct where id = 1").get()).v, safe ? 9007199254740993n : 9007199254740992, "the control: the app's own statement");
    await tdb.close();
  }
  const compat = new TursoCompat(file);
  assert.deepEqual(plain(exact.runSync(compat)), exactRows, "Turso's compat Database");
  compat.close();
  // sqlite3 and sqlite round past 2^53 before Reylo sees the value: refused, naming the column; a
  // value within it is a BigInt, and goes back in (a larger one is refused before the statement runs).
  const s3 = new sqlite3.Database(file);
  await assert.rejects(exact.run(s3), rounded);
  assert.deepEqual(plain(await byV.run(s3, { v: 5n })), [{ id: 2, v: 5n }], "sqlite3: a BIGINT within 2^53, as a parameter and back");
  await new Promise((resolve) => s3.close(resolve));
  const wrapper = await open({ filename: file, driver: sqlite3.Database });
  await assert.rejects(exact.run(wrapper), rounded);
  assert.deepEqual(plain(await byV.run(wrapper, { v: 5n })), [{ id: 2, v: 5n }], "sqlite: a BIGINT within 2^53");
  await wrapper.close();
});

test("SQLite: JSON a statement builds is the object its type says on every driver, and a text column that holds JSON stays a string", { skip: drivers === true ? false : drivers, timeout: 60_000 }, async () => {
  const Database = require("better-sqlite3");
  const { createClient } = require("@libsql/client");
  const sqlite3 = require("sqlite3");
  const { open } = require("sqlite");
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
    // a truth value is 1 or 0 there, and a BOOLEAN column what it holds.
    values: `select json_object('big', github_id, 'score', score, 'flag', active, 'more', id > 1, 'pair', json_array(name, score), 'doc', doc) as o,
  doc, json_object('n', name) || '' as glued from users order by id`,
  };
  // The types the module declares, as the type check renders them.
  writeFileSync(join(root, ".env"), "DATABASE_URL=file:./app.db\n");
  const session = await Session.for(root);
  try {
    const types: Record<string, string> = {};
    for (const [name, text] of Object.entries(sql)) {
      const outcome = await session.analyze(text);
      assert.ok(outcome.ok, `${name}: ${outcome.ok ? "" : outcome.message}`);
      types[name] = outcome.analysis.columns.map((c) => `${c.name}: ${renderType(c.type, false, "sqlite")}${c.nullable ? " | null" : ""}`).join("; ");
    }
    assert.deepEqual(types, {
      profile: "profile: { user: { id: number; name: string }; posts: { id: number; title: string }[] }",
      values: "o: { big: number | null; score: number | null; flag: number | string; more: number; pair: [string, number | null]; doc: string | null }; doc: string | null; glued: string",
    });
  } finally {
    await session.close();
  }
  const profile = await built(root, "file:./app.db", "profile", sql.profile);
  const values = await built(root, "file:./app.db", "values", sql.values);
  const ann = { profile: { user: { id: 1, name: "ann" }, posts: [{ id: 10, title: "hello" }, { id: 11, title: "world" }] } };
  const bob = { profile: { user: { id: 2, name: "bob" }, posts: [] } };
  const rows = [
    { o: { big: 9007199254740992, score: 1.5, flag: 1, more: 0, pair: ["ann", 1.5], doc: "[1]" }, doc: "[1]", glued: '{"n":"ann"}' },
    { o: { big: null, score: null, flag: 0, more: 1, pair: ["bob", null], doc: null }, doc: null, glued: '{"n":"bob"}' },
  ];
  const check = async (label: string, run: (q: any, params?: object) => unknown) => {
    assert.deepEqual(plain(await run(profile, { id: 1 })), ann, `${label}: the profile`);
    assert.deepEqual(plain(await run(profile, { id: 2 })), bob, `${label}: a user with no posts`);
    assert.deepEqual(plain(await run(values)), rows, `${label}: the values`);
  };
  for (const safe of [false, true]) {
    const db = new Database(file);
    db.defaultSafeIntegers(safe);
    await check(`better-sqlite3 with defaultSafeIntegers(${safe})`, (q, p) => q.runSync(db, p));
    assert.equal(typeof db.prepare("select json_object('a', 1) as o").get().o, "string", "the control: the app's own statement");
    db.close();
  }
  for (const readBigInts of [false, true]) {
    const node = new DatabaseSync(file, { readBigInts });
    await check(`node:sqlite with readBigInts ${readBigInts}`, (q, p) => q.run(node, p));
    node.close();
  }
  for (const intMode of ["number", "bigint", "string"]) {
    const client = createClient({ url: `file:${file}`, intMode });
    await check(`libSQL with intMode ${intMode}`, (q, p) => q.run(client, p));
    client.close();
  }
  const turso = await import(pathToFileURL(require.resolve("@tursodatabase/database")).href);
  const { Database: TursoCompat } = await import(pathToFileURL(require.resolve("@tursodatabase/database/compat")).href);
  const tdb = await turso.connect(file);
  await check("Turso's engine", (q, p) => q.run(tdb, p));
  await tdb.close();
  const compat = new TursoCompat(file);
  await check("Turso's compat Database", (q, p) => q.runSync(compat, p));
  compat.close();
  const s3 = new sqlite3.Database(file);
  await check("sqlite3", (q, p) => q.run(s3, p));
  await new Promise((resolve) => s3.close(resolve));
  const wrapper = await open({ filename: file, driver: sqlite3.Database });
  await check("sqlite", (q, p) => q.run(wrapper, p));
  await wrapper.close();
});
