// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to inspect or write files through the host filesystem.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to await writes and reads through the host filesystem.
import { writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to use the host resolver for the installed driver or fixture package.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import { join } from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to convert local module URLs with the host platform's path rules.
import { pathToFileURL } from "node:url";
import { differences, sqliteDefault } from '#reylo-source/fresh.ts';
import type { Fresh } from '#reylo-source/fresh.ts';
import { sqlModule } from "#reylo-source/loader.ts";
import { DRIVERS, INDEX, closeSessions } from "./helpers.ts";

// The schema freshness check compares the facts a built SQLite query read against the current schema.
const tursoLive = existsSync(join(DRIVERS, "@tursodatabase", "database")) ? false : "lab/drivers is not installed";

const project = function (driver?: string): string {
  const root = mkdtempSync(join(tmpdir(), "reylo-fresh-"));
  writeFileSync(join(root, "package.json"), "{}");
  if (driver) {
    mkdirSync(join(root, "node_modules"));
    symlinkSync(join(DRIVERS, driver), join(root, "node_modules", driver));
  }
  return root;
};

/** A module built for `sql` and imported: each call gives a query object of its own, never checked yet. */
const built = async function (root: string, url: string, name: string, sql: string) {
  const file = join(root, `${name}.sql`);
  await writeFile(file, sql);
  await writeFile(join(root, ".env"), `DATABASE_URL=${url}\n`);
  const { code } = await sqlModule(file, sql);
  const out = join(root, `${name}.mjs`);
  await writeFile(out, code.replace(`from "@totto2727/reylo"`, `from ${JSON.stringify(INDEX)}`));
  return (await import(`${pathToFileURL(out).href}?${Math.random()}`)).default;
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a difference is a change: a column gone, retyped, made nullable or given a default, and a column an insert must now fill; rows of another shape check nothing", () => {
  const fresh: Fresh = {
    query: "…",
    rows: [
      ["users", "id", "integer", "true", "true"],
      ["users", "email", "text", "true", "false"],
    ],
    inserts: ["users"],
  };
  assert.deepEqual(differences(fresh, [["users", "id", "integer", "true", "true"], ["users", "email", "text", "true", "false"], ["users", "bio", "text", "false", "false"]]), []);
  assert.deepEqual(differences(fresh, [{ fresh_table: "users", fresh_column: "id", fresh_type: "integer", fresh_not_null: true, fresh_default: true }]), ["users.email was text not null and no longer exists"]);
  assert.deepEqual(differences(fresh, [["users", "id", "bigint", "true", "true"], ["users", "email", "text", "false", "false"]]), ["users.id was integer not null with a default and is now bigint not null with a default", "users.email was text not null and is now text"]);
  assert.deepEqual(differences(fresh, [...fresh.rows, ["users", "tenant", "integer", "true", "false"]]), ["users.tenant is now integer not null, which the insert does not write"]);
  // A client that answers every query with a row of its own, as lab/nextjs's edge stub does, is no catalog.
  assert.equal(differences(fresh, [{ id: 1, name: "stub", email: null, role: "member", big: "7" }]), undefined);
  assert.equal(differences(fresh, [["users", "id", "integer"]]), undefined);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a default a structured insert copied is a fact by its text: changed, given or dropped, it fails the call; another column's default text is no fact", () => {
  const fresh: Fresh = {
    query: "…",
    rows: [
      ["accounts", "name", "text", "true", "false", ""],
      ["accounts", "role", "text", "true", "true", "'member'::text"],
      ["accounts", "email", "text", "false", "false", ""],
    ],
    inserts: ["accounts"],
    defaults: [["accounts", "role"], ["accounts", "email"]],
  };
  const now = (role: string, email: string, name = "") => [["accounts", "name", "text", "true", "false", name], ["accounts", "role", "text", "true", "true", role], ["accounts", "email", "text", "false", email ? "true" : "false", email]];
  assert.deepEqual(differences(fresh, now("'member'::text", "", "'x'::text")), []);
  assert.deepEqual(differences(fresh, now("'guest'::text", "")), ["accounts.role had the default 'member'::text, which the insert writes for a row that leaves its key out, and now has the default 'guest'::text"]);
  assert.deepEqual(differences(fresh, [{ fresh_table: "accounts", fresh_column: "name", fresh_type: "text", fresh_not_null: true, fresh_default: false, fresh_expr: null }, { fresh_table: "accounts", fresh_column: "role", fresh_type: "text", fresh_not_null: true, fresh_default: true, fresh_expr: "'member'::text" }, { fresh_table: "accounts", fresh_column: "email", fresh_type: "text", fresh_not_null: false, fresh_default: false, fresh_expr: null }]), []);
  // A default given to a column that had none is a change of the facts the module already compares.
  assert.deepEqual(differences(fresh, now("'member'::text", "'a@x'::text")), ["accounts.email was text and is now text with a default"]);
  // Rows of five values are not this module's catalog query.
  assert.equal(differences(fresh, [["accounts", "role", "text", "true", "true"]]), undefined);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a SQLite default is compared in one spelling, as node:sqlite and Turso's engine write the same one differently", () => {
  Iterator.from([["member", "'member'"], ['"quoted"', "'quoted'"], ["lower(hex(randomblob(4)))", "(lower (hex (randomblob (4))))"], ["-7", "- 7"], ["current_timestamp", "CURRENT_TIMESTAMP"], ["true", "TRUE"], ["x'00ff'", "x'00ff'"], ["'it''s A b'", "'it''s A b'"]]).forEach(([sqlite, turso]) => {
    assert.equal(sqliteDefault(sqlite!), sqliteDefault(turso!), `${sqlite} and ${turso}`);
  });
  Iterator.from([["'member'", "'Member'"], ["'a b'", "'ab'"], ["7", "-7"], ["member", "'guest'"]]).forEach(([a, b]) => {assert.notEqual(sqliteDefault(a!), sqliteDefault(b!), `${a} and ${b}`);});
  const fresh: Fresh = { query: "…", rows: [["a", "role", "TEXT", "1", "1", "lower(hex(randomblob(4)))"]], inserts: ["a"], defaults: [["a", "role"]] };
  assert.deepEqual(differences(fresh, [["a", "role", "text", "1", "1", "(lower (hex (randomblob (4))))"]], "sqlite"), []);
  assert.equal(differences(fresh, [["a", "role", "text", "1", "1", "(lower (hex (randomblob (4))))"]], "postgres")?.length, 1);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a SQLite type is compared without its case, as SQLite reads one; a Postgres or MySQL type exactly", () => {
  const fresh: Fresh = { query: "…", rows: [["t", "id", "INTEGER", "0", "1"], ["t", "n", "bigInt", "1", "0"]], inserts: [] };
  // SQLite's pragma_table_xinfo upper-cases a type name it knows; Turso's engine gives it as declared.
  const turso = [["t", "id", "integer", "0", "1"], ["t", "n", "bigint", "1", "0"]];
  assert.deepEqual(differences(fresh, turso, "sqlite"), []);
  assert.deepEqual(differences(fresh, [["t", "id", "integer", "1", "1"], ["t", "n", "text", "1", "0"]], "sqlite"), ["t.id was INTEGER with a default and is now integer not null with a default", "t.n was bigInt not null and is now text not null"]);
  assert.deepEqual(differences(fresh, turso, "postgres"), ["t.id was INTEGER with a default and is now integer with a default", "t.n was bigInt not null and is now bigint not null"]);
  assert.equal(differences(fresh, turso, "mysql")?.length, 2);
  // SQLite folds ASCII letters alone.
  assert.deepEqual(differences({ query: "…", rows: [["t", "x", "É", "0", "0"]], inserts: [] }, [["t", "x", "é", "0", "0"]], "sqlite"), ["t.x was É and is now é"]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite on Turso's engine: a query built on node:sqlite runs, whose types Turso spells in lowercase, and a column it names, renamed, fails the call", { skip: tursoLive }, async () => {
  const require = createRequire(join(DRIVERS, "package.json"));
  const { connect } = await import(pathToFileURL(require.resolve("@tursodatabase/database")).href);
  const root = project();
  const file = join(root, "app.db");
  const setup = new DatabaseSync(file);
  setup.exec("create table users (id integer primary key, email text not null, n bigInt, ok boolean)");
  setup.exec("insert into users (email, n, ok) values ('a@x', 7, 1)");
  setup.exec("create table accounts (id integer primary key, name text not null, role text not null default member, tok text not null default (lower(hex(randomblob(4)))), n integer default -7)");
  setup.close();
  const url = "file:./app.db";
  const db = await connect(file);
  try {
    const read = await built(root, url, "read", "select id, email, n, ok from users order by id");
    const facts = JSON.parse(/"rows":(\[\[.*?\]\]),"inserts"/.exec(readFileSync(join(root, "read.mjs"), "utf8"))![1]!) as string[][];
    assert.deepEqual(facts.map((r) => r[2]), ["TEXT", "INTEGER", "bigInt", "boolean"], "the facts node:sqlite gave the build, the names it knows upper-cased");
    assert.deepEqual((await db.prepare("select type from pragma_table_xinfo('users')").all()).map((r: { type: string }) => r.type), ["integer", "text", "bigInt", "boolean"], "the control: Turso's engine gives each type as declared");
    // A column declared BIGINT, in any case, is a BigInt.
    assert.deepEqual(await read.run(db), [{ id: 1, email: "a@x", n: BigInt("7"), ok: true }]);
    // A structured insert built on node:sqlite copies the defaults node:sqlite reads, which Turso
    // Writes again in its own spelling and evaluates the same, rows that leave out different keys included.
    const insert = await built(root, url, "insert", "insert into accounts :a::rows(name text not null, role? text not null, tok? text not null, n integer) returning id, role, n");
    assert.deepEqual(await insert.run(db, { a: [{ name: "Ada" }, { name: "Grace", role: "admin", tok: "t", n: null }] }), [{ id: 1, n: -7, role: "member" }, { id: 2, n: null, role: "admin" }]);
    const read2 = await built(root, url, "read2", "select id, email from users order by id");
    await db.exec("alter table users rename column email to mail");
    await assert.rejects(read2.run(db), /The database changed after read2\.sql was built: users\.email was TEXT not null and no longer exists\. Build it again/u);
  } finally {
    await db.close();
    await closeSessions();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a query whose columns changed fails, naming them; one whose table gained a column it does not name runs", async () => {
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table users (id integer primary key, email text not null, name text)");
  db.exec("insert into users (email, name) values ('a@x', 'Ada')");
  const url = "file:./app.db";
  try {
    const read = await built(root, url, "read", "select id, email from users order by id");
    assert.deepEqual((await read.run(db)).map((r: object) => ({ ...r })), [{ email: "a@x", id: 1 }]);
    // A column the statement does not name: no fact, so the query runs on.
    db.exec("alter table users add column bio text");
    const read2 = await built(root, url, "read2", "select id, email from users order by id");
    db.exec("alter table users add column age integer");
    assert.equal((await read2.run(db)).length, 1);
    // A column it names, renamed: the call fails before the statement runs, synchronously too.
    const read3 = await built(root, url, "read3", "select id, email from users order by id");
    db.exec("alter table users rename column email to mail");
    await assert.rejects(read3.run(db), /The database changed after read3\.sql was built: users\.email was TEXT not null and no longer exists\. Build it again/u);
    const read4 = await built(root, url, "read4", "select id, name from users order by id");
    db.exec("alter table users rename column name to full_name");
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    assert.throws(() => read4.runSync(db), /users\.name was TEXT and no longer exists/u);
    // An insert's table that gains a column it must fill.
    const insert = await built(root, url, "insert", "insert into users (mail) values (:mail)");
    db.exec("alter table users add column tenant integer not null default 0");
    await insert.run(db, { mail: "b@x" });
  } finally {
    db.close();
    await closeSessions();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a default a structured insert copied, changed after the build, fails the call naming the table and the column", async () => {
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table accounts (id integer primary key, name text not null, role text not null default 'member')");
  const url = "file:./app.db";
  const insert = "insert into accounts :a::rows(name text not null, role? text not null) returning role";
  try {
    const q = await built(root, url, "insert_accounts", insert);
    assert.deepEqual((await q.run(db, { a: [{ name: "Ada" }, { name: "Grace", role: "admin" }] })).map((r: object) => ({ ...r })), [{ role: "member" }, { role: "admin" }]);
    // A table rebuilt with another default: the module would still write 'member'.
    const stale = await built(root, url, "insert_accounts2", insert);
    db.exec(`create table accounts_new (id integer primary key, name text not null, role text not null default 'guest');
      insert into accounts_new select * from accounts; drop table accounts; alter table accounts_new rename to accounts`);
    await assert.rejects(stale.run(db, { a: [{ name: "Linus" }] }), /The database changed after insert_accounts2\.sql was built: accounts\.role had the default 'member', which the insert writes for a row that leaves its key out, and now has the default 'guest'\. Build it again/u);
    assert.equal((db.prepare("select count(*) as n from accounts").get() as { n: number }).n, 2);
    // A query that does not copy the default runs on.
    const read = await built(root, url, "read", "select name, role from accounts order by id");
    assert.equal((await read.run(db)).length, 2);
  } finally {
    db.close();
    await closeSessions();
  }
});
