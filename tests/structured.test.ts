// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with the native Node test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Compare native SQLite rows and mapper diagnostics.
import assert from "node:assert/strict";
import { sqlModule } from "#reylo-source/loader.ts";
import { plain, requireFixtureValue, forEachFixtureInOrder, SQL_NULL } from "./helpers.ts";
import { analysis, built, querySource, withProject } from "./sqlite-project-fixture.ts";
// oxlint-disable-next-line rules/no-node-imports -- The integration suite exercises the real synchronous host SQLite driver.
import type { DatabaseSync } from "node:sqlite";

const checkEventRowType = async function (root: string, insert: string): Promise<void> {
  const report = await analysis(root, insert);
  assert.deepEqual(report.params.map((parameter) => [parameter.name, parameter.type_name]), [["events", "rows"]]);
  const events = requireFixtureValue(report.params[0]).type;
  assert.ok(events.kind === "rows");
  assert.deepEqual(events.fields.map((field) => [field.name, field.type.kind === "scalar" ? field.type.name : field.type.kind, field.nullable, field.optional]), [["id", "integer", false, false], ["ts", "text", false, false], ["status", "text", false, true], ["amount", "real", true, true], ["meta", "json", true, true]]);
};

const checkStoredEvents = function (database: DatabaseSync): void {
  // An explicit null stores NULL, never the text null, and a document stays JSON text.
  const stored = database.prepare("select id, status, amount, meta, typeof(meta) as t from events order by id").all();
  assert.deepEqual(plain(stored), [
    { amount: SQL_NULL, id: 1, meta: SQL_NULL, status: "late", t: "null" },
    { amount: 1.5, id: 2, meta: `{"source":"x"}`, status: "done", t: "text" },
    { amount: SQL_NULL, id: 3, meta: SQL_NULL, status: "new", t: "null" },
  ]);
};

const checkEventUpsert = async function (root: string, database: DatabaseSync): Promise<void> {
  // An upsert reads ON CONFLICT as its own, since the expansion ends in WHERE.
  const upsert = await built(root, "upsert", "insert into events :events::rows(id integer not null, ts text not null) on conflict (id) do update set ts = excluded.ts returning id, ts");
  assert.deepEqual(plain(await upsert.run(database, { events: [{ id: 3, ts: "2026-10-22" }] })), [{ id: 3, ts: "2026-10-22" }]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: an insert's rows are checked and written in their order, a key left out takes its default, and the column list types the parameter", async () => {
  await withProject("create table events (id integer primary key, ts text not null, status text not null default 'new', amount real, meta text)", async ({ database, root }) => {
    const insert = `insert into events :events::rows(id integer not null, ts text not null, status? text not null, amount real, meta json('{"type": "object", "properties": {"source": {"type": "string"}}}')) returning id, status`;
    await checkEventRowType(root, insert);
    const query = await built(root, "insert_events", insert);
    assert.deepEqual(plain(await query.run(database, { events: [{ amount: 1.5, id: 2, meta: { source: "x" }, status: "done", ts: "2026-10-20" }, { amount: SQL_NULL, id: 1, meta: SQL_NULL, status: "late", ts: "2026-10-20" }] })), [{ id: 2, status: "done" }, { id: 1, status: "late" }]);
    assert.deepEqual(plain(await query.run(database, { events: [{ id: 3, ts: "2026-10-21" }] })), [{ id: 3, status: "new" }]);
    await assert.rejects(query.run(database, { events: [{ id: 4, status: SQL_NULL, ts: "x" }] }), /"status" is text not null, and the row gives null/u);
    await assert.rejects(query.run(database, { events: [{ id: "4", ts: "x" }] }), /"id" is integer, an integer; got "4"/u);
    checkStoredEvents(database);
    // Rows that leave out different keys go in one insert, each such row with the default.
    assert.deepEqual(plain(await query.run(database, { events: [{ id: 4, ts: "x" }, { id: 5, status: "s", ts: "x" }] })), [{ id: 4, status: "new" }, { id: 5, status: "s" }]);
    await checkEventUpsert(root, database);
  });
});

const checkAccountDefaults = function (database: DatabaseSync): void {
  const stored = database.prepare("select id, name, email, role, nick, token, n, at, typeof(n) as tn from accounts order by id").all();
  // A key left out takes the default; a key given as null is NULL; the bare identifier `member` is the string SQLite stores.
  assert.deepEqual(stored.map((row) => [row.id, row.email, row.role, row.nick, row.n, row.tn]), [[1, SQL_NULL, "member", "member", 7, "integer"], [100, SQL_NULL, "admin", "g", 1, "integer"], [101, SQL_NULL, "member", SQL_NULL, SQL_NULL, "null"]]);
  // An expression default runs per row, current_timestamp once per statement, as the database's own.
  assert.equal(requireFixtureValue(stored[1]).token, "given");
  assert.match(String(requireFixtureValue(stored[0]).token), /^[0-9a-f]{16}$/u);
  assert.match(String(requireFixtureValue(stored[2]).token), /^[0-9a-f]{16}$/u);
  assert.notEqual(requireFixtureValue(stored[0]).token, requireFixtureValue(stored[2]).token);
  assert.equal(requireFixtureValue(stored[0]).at, requireFixtureValue(stored[2]).at);
  assert.match(String(requireFixtureValue(stored[0]).at), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/u);
};

const checkAccountRow = async function (root: string, database: DatabaseSync): Promise<void> {
  // One row: the same.
  const one = await built(root, "insert_account", "insert into accounts :a::row(name text not null, role? text not null) returning role");
  assert.deepEqual(plain(await one.run(database, { a: { name: "Mary" } })), [{ role: "member" }]);
  assert.deepEqual(plain(await one.run(database, { a: { name: "Ken", role: "owner" } })), [{ role: "owner" }]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: rows that leave out different keys go in one insert, each such row with its column's default copied from the catalog", async () => {
  await withProject(`create table accounts (id integer primary key, name text not null, email text, role text not null default 'member',
    nick text default member, token text not null default (lower(hex(randomblob(8)))), n integer default 7, at text not null default current_timestamp)`, async ({ database, root }) => {
    const insert = "insert into accounts :a::rows(id? integer not null, name text not null, email text, role? text not null, nick text, token? text not null, n integer, at? text not null) returning id, role";
    const file = await querySource(root, "insert_accounts", insert);
    // One statement for every call: no list for the run time to write again.
    const { code } = await sqlModule(file, insert);
    assert.ok(!code.includes("structured:"), code);
    const query = await built(root, "insert_accounts", insert);
    assert.match(query.sql, /CASE WHEN json_type\("reylo\.e"\.value, '\$\."role"'\) IS NOT NULL THEN "reylo\.e"\.value ->> '\$\."role"' ELSE \('member'\) END/u);
    const rows = [{ name: "Ada" }, { id: 100, n: 1, name: "Grace", nick: "g", role: "admin", token: "given" }, { email: SQL_NULL, n: SQL_NULL, name: "Linus", nick: SQL_NULL }];
    assert.deepEqual(plain(await query.run(database, { a: rows })), [{ id: 1, role: "member" }, { id: 100, role: "admin" }, { id: 101, role: "member" }]);
    checkAccountDefaults(database);
    await checkAccountRow(root, database);
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: elsewhere a rows parameter is a table named by its alias or by the parameter, a not null key never null and the rest nullable", async () => {
  await withProject("", async ({ database, root }) => {
    const sql = "select e.id, e.note from :events::rows(id integer not null, note text) as e order by e.id";
    const report = await analysis(root, sql);
    assert.deepEqual(report.columns.map((column) => [column.name, column.nullable]), [["id", false], ["note", true]]);
    const query = await built(root, "select_events", sql);
    assert.deepEqual(plain(await query.run(database, { events: [{ id: 2 }, { id: 1, note: "a" }] })), [{ id: 1, note: "a" }, { id: 2, note: SQL_NULL }]);
    const unaliased = await analysis(root, "select events.id from :events::rows(id integer not null)");
    assert.deepEqual(unaliased.columns.map((column) => [column.name, column.nullable]), [["id", false]]);
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a column list that does not read is the type check's error at its place, and fails the build", async () => {
  await withProject("", async ({ database, root }) => {
    database.close();
    const cases: [string, string, RegExp][] = [
      ["insert into t :p::rows(a text not null default 'x')", "default", /never restates a default/u],
      ["insert into t :p::rows(a? text)", "a?", /may be left out already/u],
      ["select * from :p::rows(a? text not null)", "a?", /only where the rows are inserted/u],
      ["insert into t :p::row(a text, posts rows(title text))", "rows(title text)", /nested row or rows member is not built yet/u],
    ];
    await forEachFixtureInOrder(cases, async ([sql, at, message]) => {
      const report = await analysis(root, sql);
      const currentDiagnostic = report.diagnostics.find((diagnostic) => diagnostic.code === 20);
      assert.ok(currentDiagnostic, sql);
      assert.match(currentDiagnostic.message, message);
      assert.equal(sql.slice(currentDiagnostic.start, currentDiagnostic.start + currentDiagnostic.length), at, sql);
      const file = await querySource(root, "bad", sql);
      await assert.rejects(sqlModule(file, sql), message);
    });
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: the column list is checked against the table its insert writes, and a disagreement fails the build", async () => {
  await withProject("create table events (id integer primary key, ts text not null, status text not null default 'new', amount real, total real generated always as (amount * 2))", async ({ database, root }) => {
    database.close();
    const cases: [string, string, RegExp][] = [
      ["insert into events :e::rows(id integer not null, ts text, status? text not null)", "ts text", /events\.ts is not null, and `ts` lets a row give null or leave the key out: write `ts text not null`/u],
      ["insert into events :e::rows(id integer not null, ts text not null, status text)", "status text", /write `status\? text not null`, which lets a row leave the key out so that the default applies/u],
      ["insert into events :e::rows(id integer not null, ts text not null, amount? real not null)", "amount", /`amount\?` lets a row leave the key out, but events\.amount has no default/u],
      ["insert into events :e::rows(id integer not null, status? text not null)", ":e::rows", /events\.ts is not null and has no default, and the column list leaves it out/u],
      ["insert into events :e::rows(id text not null, ts text not null)", "text", /events\.id is INTEGER, and the column list says text: their affinities differ \(TEXT and INTEGER\)/u],
      ["insert into events :e::rows(ts text not null, total real)", "total", /events\.total is a generated column/u],
    ];
    await forEachFixtureInOrder(cases, async ([sql, at, message]) => {
      const report = await analysis(root, sql);
      const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.code === 21);
      assert.equal(diagnostics.length, 1, `${sql}: ${JSON.stringify(report.diagnostics)}`);
      const diagnostic = requireFixtureValue(diagnostics[0]);
      assert.match(diagnostic.message, message);
      assert.equal(sql.slice(diagnostic.start, diagnostic.start + diagnostic.length), at, sql);
      const file = await querySource(root, "bad", sql);
      await assert.rejects(sqlModule(file, sql), message);
    });
    // The rowid is filled when it is left out, so an INTEGER PRIMARY KEY needs no `?`.
    const withoutRowid = await analysis(root, "insert into events :e::rows(ts text not null)");
    assert.deepEqual(withoutRowid.diagnostics, []);
  });
});

const checkOwnColumnList = async function (root: string): Promise<void> {
  const own = "insert into t (id, x) :p::rows(id integer not null, x text not null)";
  const report = await analysis(root, own);
  const currentDiagnostic = report.diagnostics.find((diagnostic) => diagnostic.code === 20);
  assert.ok(currentDiagnostic);
  assert.match(currentDiagnostic.message, /writes the insert's column list itself/u);
  assert.equal(own.slice(currentDiagnostic.start, currentDiagnostic.start + currentDiagnostic.length), "(id, x)");
  const file = await querySource(root, "own", own);
  await assert.rejects(sqlModule(file, own), /writes the insert's column list itself/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an insert takes the table's alias before its rows, and refuses a column list of its own at the author's text", async () => {
  await withProject("create table t (id integer primary key, x text not null)", async ({ database, root }) => {
    database.exec("insert into t values (1, 'a'), (2, 'b')");
    const upsert = await built(root, "aliased", "insert into t as tt :p::rows(id integer not null, x text not null) on conflict (id) do update set x = excluded.x where tt.x <> excluded.x returning id, x");
    assert.deepEqual(plain(await upsert.run(database, { p: [{ id: 2, x: "B" }, { id: 3, x: "c" }] })), [{ id: 2, x: "B" }, { id: 3, x: "c" }]);
    await checkOwnColumnList(root);
  });
});
