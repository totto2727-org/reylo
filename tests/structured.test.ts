import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Session } from "../src/analyze.ts";
import { sqlModule } from "../src/loader.ts";
import { DRIVERS, INDEX, closeSessions, plain } from "./helpers.ts";

// Structured parameters (wiki/structured-params.md): a parameter cast to `rows(…)` or `row(…)` is
// typed by its column list and written for its position; the run time checks each value, and a key
// a row leaves out takes its column's default, copied from SQLite's catalog into the insert.

function project(driver?: string): string {
  const root = mkdtempSync(join(tmpdir(), "reylo-structured-"));
  writeFileSync(join(root, "package.json"), "{}");
  if (driver) {
    mkdirSync(join(root, "node_modules"));
    symlinkSync(join(DRIVERS, driver), join(root, "node_modules", driver));
  }
  return root;
}

/** The module a build step writes for `sql`, imported. */
async function built(root: string, url: string, name: string, sql: string) {
  const file = join(root, `${name}.sql`);
  writeFileSync(file, sql);
  writeFileSync(join(root, ".env"), `DATABASE_URL=${url}\n`);
  const { code } = await sqlModule(file, sql);
  const out = join(root, `${name}.mjs`);
  writeFileSync(out, code.replace(`from "@totto2727/reylo"`, `from ${JSON.stringify(INDEX)}`));
  return (await import(pathToFileURL(out).href)).default;
}

async function analysis(root: string, url: string, sql: string) {
  const session = await Session.open(root, { DATABASE_URL: url });
  try {
    const outcome = await session.analyze(sql, { force: true });
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
    return outcome.analysis;
  } finally {
    await session.close();
  }
}

// The rows as plain objects: drivers return them with their own prototypes and extra properties.

test("SQLite: an insert's rows are checked and written in their order, a key left out takes its default, and the column list types the parameter", async () => {
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table events (id integer primary key, ts text not null, status text not null default 'new', amount real, meta text)");
  const url = "file:./app.db";
  const insert = `insert into events :events::rows(id integer not null, ts text not null, status? text not null, amount real, meta json('{"type": "object", "properties": {"source": {"type": "string"}}}')) returning id, status`;
  try {
    const a = await analysis(root, url, insert);
    assert.deepEqual(a.params.map((p) => [p.name, p.type_name]), [["events", "rows"]]);
    const events = a.params[0]!.type;
    assert.ok(events.kind === "rows");
    assert.deepEqual(events.fields.map((f) => [f.name, f.type.kind === "scalar" ? f.type.name : f.type.kind, f.nullable, f.optional]), [["id", "integer", false, false], ["ts", "text", false, false], ["status", "text", false, true], ["amount", "real", true, true], ["meta", "json", true, true]]);
    const q = await built(root, url, "insert_events", insert);
    assert.deepEqual(plain(await q.run(db, { events: [{ id: 2, ts: "2026-10-20", status: "done", amount: 1.5, meta: { source: "x" } }, { id: 1, ts: "2026-10-20", status: "late", amount: null, meta: null }] })), [{ id: 2, status: "done" }, { id: 1, status: "late" }]);
    assert.deepEqual(plain(await q.run(db, { events: [{ id: 3, ts: "2026-10-21" }] })), [{ id: 3, status: "new" }]);
    await assert.rejects(q.run(db, { events: [{ id: 4, ts: "x", status: null }] }), /"status" is text not null, and the row gives null/);
    await assert.rejects(q.run(db, { events: [{ id: "4", ts: "x" }] }), /"id" is integer, an integer; got "4"/);
    // An explicit null stores NULL, never the text null, and a document stays JSON text.
    assert.deepEqual(db.prepare("select id, status, amount, meta, typeof(meta) as t from events order by id").all().map((r) => ({ ...r })), [
      { id: 1, status: "late", amount: null, meta: null, t: "null" },
      { id: 2, status: "done", amount: 1.5, meta: `{"source":"x"}`, t: "text" },
      { id: 3, status: "new", amount: null, meta: null, t: "null" },
    ]);
    // Rows that leave out different keys go in one insert, each such row with the default.
    assert.deepEqual(plain(await q.run(db, { events: [{ id: 4, ts: "x" }, { id: 5, ts: "x", status: "s" }] })), [{ id: 4, status: "new" }, { id: 5, status: "s" }]);
    // An upsert reads ON CONFLICT as its own, since the expansion ends in WHERE.
    const upsert = await built(root, url, "upsert", "insert into events :events::rows(id integer not null, ts text not null) on conflict (id) do update set ts = excluded.ts returning id, ts");
    assert.deepEqual(plain(await upsert.run(db, { events: [{ id: 3, ts: "2026-10-22" }] })), [{ id: 3, ts: "2026-10-22" }]);
  } finally {
    db.close();
    await closeSessions();
  }
});

test("SQLite: rows that leave out different keys go in one insert, each such row with its column's default copied from the catalog", async () => {
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec(`create table accounts (id integer primary key, name text not null, email text, role text not null default 'member',
    nick text default member, token text not null default (lower(hex(randomblob(8)))), n integer default 7, at text not null default current_timestamp)`);
  const url = "file:./app.db";
  const insert = "insert into accounts :a::rows(id? integer not null, name text not null, email text, role? text not null, nick text, token? text not null, n integer, at? text not null) returning id, role";
  try {
    const file = join(root, "insert_accounts.sql");
    writeFileSync(file, insert);
    writeFileSync(join(root, ".env"), `DATABASE_URL=${url}\n`);
    // One statement for every call: no list for the run time to write again.
    const { code } = await sqlModule(file, insert);
    assert.ok(!code.includes("structured:"), code);
    const q = await built(root, url, "insert_accounts", insert);
    assert.match(q.sql, /CASE WHEN json_type\("reylo\.e"\.value, '\$\."role"'\) IS NOT NULL THEN "reylo\.e"\.value ->> '\$\."role"' ELSE \('member'\) END/);
    const rows = [{ name: "Ada" }, { id: 100, name: "Grace", role: "admin", nick: "g", token: "given", n: 1 }, { name: "Linus", email: null, nick: null, n: null }];
    assert.deepEqual(plain(await q.run(db, { a: rows })), [{ id: 1, role: "member" }, { id: 100, role: "admin" }, { id: 101, role: "member" }]);
    const stored = db.prepare("select id, name, email, role, nick, token, n, at, typeof(n) as tn from accounts order by id").all().map((r) => ({ ...r })) as Record<string, unknown>[];
    // A key left out takes the default; a key given as null is NULL; the bare identifier `member` is the string SQLite stores.
    assert.deepEqual(stored.map((r) => [r.id, r.email, r.role, r.nick, r.n, r.tn]), [[1, null, "member", "member", 7, "integer"], [100, null, "admin", "g", 1, "integer"], [101, null, "member", null, null, "null"]]);
    // An expression default runs per row, current_timestamp once per statement, as the database's own.
    assert.equal(stored[1]!.token, "given");
    assert.match(String(stored[0]!.token), /^[0-9a-f]{16}$/);
    assert.match(String(stored[2]!.token), /^[0-9a-f]{16}$/);
    assert.notEqual(stored[0]!.token, stored[2]!.token);
    assert.equal(stored[0]!.at, stored[2]!.at);
    assert.match(String(stored[0]!.at), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    // One row: the same.
    const one = await built(root, url, "insert_account", "insert into accounts :a::row(name text not null, role? text not null) returning role");
    assert.deepEqual(plain(await one.run(db, { a: { name: "Mary" } })), [{ role: "member" }]);
    assert.deepEqual(plain(await one.run(db, { a: { name: "Ken", role: "owner" } })), [{ role: "owner" }]);
  } finally {
    db.close();
    await closeSessions();
  }
});

test("SQLite: elsewhere a rows parameter is a table named by its alias or by the parameter, a not null key never null and the rest nullable", async () => {
  const root = project();
  new DatabaseSync(join(root, "app.db")).close();
  const url = "file:./app.db";
  const sql = "select e.id, e.note from :events::rows(id integer not null, note text) as e order by e.id";
  try {
    const a = await analysis(root, url, sql);
    assert.deepEqual(a.columns.map((c) => [c.name, c.nullable]), [["id", false], ["note", true]]);
    const q = await built(root, url, "select_events", sql);
    const db = new DatabaseSync(join(root, "app.db"));
    try {
      assert.deepEqual(plain(await q.run(db, { events: [{ id: 2 }, { id: 1, note: "a" }] })), [{ id: 1, note: "a" }, { id: 2, note: null }]);
    } finally {
      db.close();
    }
    const unaliased = await analysis(root, url, "select events.id from :events::rows(id integer not null)");
    assert.deepEqual(unaliased.columns.map((c) => [c.name, c.nullable]), [["id", false]]);
  } finally {
    await closeSessions();
  }
});

test("a column list that does not read is the type check's error at its place, and fails the build", async () => {
  const root = project();
  new DatabaseSync(join(root, "app.db")).close();
  const url = "file:./app.db";
  const cases: [string, string, RegExp][] = [
    ["insert into t :p::rows(a text not null default 'x')", "default", /never restates a default/],
    ["insert into t :p::rows(a? text)", "a?", /may be left out already/],
    ["select * from :p::rows(a? text not null)", "a?", /only where the rows are inserted/],
    ["insert into t :p::row(a text, posts rows(title text))", "rows(title text)", /nested row or rows member is not built yet/],
  ];
  try {
    for (const [sql, at, message] of cases) {
      const a = await analysis(root, url, sql);
      const d = a.diagnostics.find((d) => d.code === 20);
      assert.ok(d, sql);
      assert.match(d.message, message);
      assert.equal(sql.slice(d.start, d.start + d.length), at, sql);
      const file = join(root, "bad.sql");
      writeFileSync(file, sql);
      writeFileSync(join(root, ".env"), `DATABASE_URL=${url}\n`);
      await assert.rejects(sqlModule(file, sql), message);
    }
  } finally {
    await closeSessions();
  }
});

test("SQLite: the column list is checked against the table its insert writes, and a disagreement fails the build", async () => {
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table events (id integer primary key, ts text not null, status text not null default 'new', amount real, total real generated always as (amount * 2))");
  db.close();
  const url = "file:./app.db";
  const cases: [string, string, RegExp][] = [
    ["insert into events :e::rows(id integer not null, ts text, status? text not null)", "ts text", /events\.ts is not null, and `ts` lets a row give null or leave the key out: write `ts text not null`/],
    ["insert into events :e::rows(id integer not null, ts text not null, status text)", "status text", /write `status\? text not null`, which lets a row leave the key out so that the default applies/],
    ["insert into events :e::rows(id integer not null, ts text not null, amount? real not null)", "amount", /`amount\?` lets a row leave the key out, but events\.amount has no default/],
    ["insert into events :e::rows(id integer not null, status? text not null)", ":e::rows", /events\.ts is not null and has no default, and the column list leaves it out/],
    ["insert into events :e::rows(id text not null, ts text not null)", "text", /events\.id is INTEGER, and the column list says text: their affinities differ \(TEXT and INTEGER\)/],
    ["insert into events :e::rows(ts text not null, total real)", "total", /events\.total is a generated column/],
  ];
  try {
    for (const [sql, at, message] of cases) {
      const a = await analysis(root, url, sql);
      const d = a.diagnostics.filter((d) => d.code === 21);
      assert.equal(d.length, 1, `${sql}: ${JSON.stringify(a.diagnostics)}`);
      assert.match(d[0]!.message, message);
      assert.equal(sql.slice(d[0]!.start, d[0]!.start + d[0]!.length), at, sql);
      const file = join(root, "bad.sql");
      writeFileSync(file, sql);
      writeFileSync(join(root, ".env"), `DATABASE_URL=${url}\n`);
      await assert.rejects(sqlModule(file, sql), message);
    }
    // The rowid is filled when it is left out, so an INTEGER PRIMARY KEY needs no `?`.
    assert.deepEqual((await analysis(root, url, "insert into events :e::rows(ts text not null)")).diagnostics, []);
  } finally {
    await closeSessions();
  }
});




test("an imported query carries its input's and its output's JSON Schema, a structured parameter's keys included", async () => {
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table events (id integer primary key, ts text not null, status text not null default 'new', amount real)");
  db.close();
  try {
    const q = await built(root, "file:./app.db", "insert_events", "insert into events :events::rows(id integer not null, ts text not null, status? text not null, amount real) returning id, status");
    assert.deepEqual(q.inputSchema, {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "integer", format: "int64" }, ts: { type: "string" }, status: { type: "string" }, amount: { anyOf: [{ type: "number", format: "double" }, { type: "null" }] } },
            required: ["id", "ts"],
            additionalProperties: false,
          },
        },
      },
      required: ["events"],
      additionalProperties: false,
    });
    assert.deepEqual(q.outputSchema, {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "array",
      items: { type: "object", properties: { id: { type: "integer", format: "int64" }, status: { type: "string" } }, required: ["id", "status"] },
    });
    // Standard Schema's converter gives the same.
    assert.deepEqual(q["~standard"].jsonSchema.input({ target: "draft-2020-12" }), q.inputSchema);
  } finally {
    await closeSessions();
  }
});

test("SQLite: a typed JSON parameter is typed by its schema, takes its defaults, and is checked before the statement runs", async () => {
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table todos (id integer primary key, title text not null, done integer not null default 0)");
  const url = "file:./app.db";
  const insert = `insert into todos (title, done)
select value ->> '$.title', value ->> '$.done' from json_each(:todos::json('{
  "type": "array",
  "maxItems": 2,
  "items": {
    "type": "object",
    "properties": { "title": { "type": "string", "minLength": 1 }, "done": { "type": "boolean", "default": false } },
    "required": ["title", "done"],
    "additionalProperties": false
  }
}')) returning id, title, done`;
  try {
    const a = await analysis(root, url, insert);
    const p = a.params[0]!;
    assert.deepEqual([p.name, p.type_name, p.type.kind], ["todos", "json", "json"]);
    // `done` has a default, so the caller may leave it out; the run time fills it.
    assert.deepEqual(p.type.kind === "json" && p.type.schema && (p.type.schema as { items: { required: string[] } }).items.required, ["title"]);
    const q = await built(root, url, "insert_todos", insert);
    assert.deepEqual(plain(await q.run(db, { todos: [{ title: "a" }, { title: "b", done: true }] })), [{ id: 1, title: "a", done: 0 }, { id: 2, title: "b", done: 1 }]);
    await assert.rejects(q.run(db, { todos: [{ title: "" }] }), /Parameter "todos" at \/0\/title must be at least 1 characters long/);
    await assert.rejects(q.run(db, { todos: [{ title: "a", extra: 1 }] }), /at \/0\/extra is a key the schema does not allow/);
    await assert.rejects(q.run(db, { todos: [{ title: "a" }, { title: "b" }, { title: "c" }] }), /must have at most 2 items/);
    // A parameter whose schema has a default at its root may be left out.
    const limited = await built(root, url, "limited", `select id from todos order by id limit :n::json('{ "type": "integer", "minimum": 1, "maximum": 200, "default": 1 }')`);
    assert.deepEqual(plain(await limited.run(db, {})), [{ id: 1 }]);
    assert.deepEqual(plain(await limited.run(db, { n: 2 })), [{ id: 1 }, { id: 2 }]);
    await assert.rejects(limited.run(db, { n: 0 }), /Parameter "n" must be at least 1/);
    assert.deepEqual(limited.inputSchema.required, []);
    // What the profile refuses is the type check's error at the schema, and fails the build.
    const bad = `select * from json_each(:p::json('{ "$ref": "#/$defs/x" }'))`;
    const d = (await analysis(root, url, bad)).diagnostics.find((x) => x.code === 20);
    assert.ok(d);
    assert.match(d.message, /breaks the schema's locality/);
    assert.equal(bad.slice(d.start, d.start + d.length), `'{ "$ref": "#/$defs/x" }'`);
  } finally {
    db.close();
    await closeSessions();
  }
});

test("SQLite: a JSON member of a column list is checked against its schema, its nested defaults filled", async () => {
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table events (id integer primary key, meta text)");
  try {
    const q = await built(root, "file:./app.db", "insert_events", `insert into events :events::rows(id integer not null, meta json('{"type": "object", "properties": {"source": {"type": "string", "default": "web"}, "n": {"type": "integer", "minimum": 0}}, "required": ["source"]}')) returning id, meta`);
    assert.deepEqual(plain(await q.run(db, { events: [{ id: 1, meta: {} }, { id: 2, meta: { source: "app", n: 3 } }] })), [{ id: 1, meta: `{"source":"web"}` }, { id: 2, meta: `{"source":"app","n":3}` }]);
    await assert.rejects(q.run(db, { events: [{ id: 3, meta: { n: -1 } }] }), /row 1: "meta" at \/n must be at least 0/);
  } finally {
    db.close();
    await closeSessions();
  }
});

test("binary data in a column list travels as hexadecimal text, which each reader decodes", async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const same = (got: unknown) => assert.deepEqual([...new Uint8Array(got as ArrayLike<number>)], [...bytes]);
  // SQLite decodes it with unhex().
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table files (id integer primary key, data blob not null)");
  try {
    const insert = await built(root, "file:./app.db", "insert_files", "insert into files :files::rows(id integer not null, data blob not null) returning id, data");
    const [row] = await insert.run(db, { files: [{ id: 1, data: bytes }] });
    same(row.data);
    const read = await built(root, "file:./app.db", "read_files", "select f.data from :files::rows(data blob not null) as f");
    same((await read.run(db, { files: [{ data: bytes }] }))[0].data);
    await assert.rejects(insert.run(db, { files: [{ id: 2, data: "00ff" }] }), /"data" is blob, binary data, a Uint8Array; got "00ff"/);
  } finally {
    db.close();
    await closeSessions();
  }
});


test("an insert takes the table's alias before its rows, and refuses a column list of its own at the author's text", async () => {
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table t (id integer primary key, x text not null)");
  db.exec("insert into t values (1, 'a'), (2, 'b')");
  const url = "file:./app.db";
  try {
    const upsert = await built(root, url, "aliased", "insert into t as tt :p::rows(id integer not null, x text not null) on conflict (id) do update set x = excluded.x where tt.x <> excluded.x returning id, x");
    assert.deepEqual(plain(await upsert.run(db, { p: [{ id: 2, x: "B" }, { id: 3, x: "c" }] })), [{ id: 2, x: "B" }, { id: 3, x: "c" }]);
    const own = "insert into t (id, x) :p::rows(id integer not null, x text not null)";
    const d = (await analysis(root, url, own)).diagnostics.find((x) => x.code === 20);
    assert.ok(d);
    assert.match(d.message, /writes the insert's column list itself/);
    assert.equal(own.slice(d.start, d.start + d.length), "(id, x)");
    writeFileSync(join(root, "own.sql"), own);
    await assert.rejects(sqlModule(join(root, "own.sql"), own), /writes the insert's column list itself/);
  } finally {
    db.close();
    await closeSessions();
  }
});
