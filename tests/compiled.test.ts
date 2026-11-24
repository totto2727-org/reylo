// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to inspect or write files through the host filesystem.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to await writes and reads through the host filesystem.
import { writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import { join } from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to convert local module URLs with the host platform's path rules.
import { pathToFileURL } from "node:url";
import { sqlModule } from "#reylo-source/loader.ts";
import { defineQuery } from "#reylo-source/index.ts";
import { declarations, DRIVERS, INDEX, closeSessions, requireFixtureValue } from "./helpers.ts";

// A query's `sql` is the statement as Reylo sends it to the database, the engine's compiled text,
// And `raw` the file as written. Both are the module's exports too,
// And the content mapper declares both as string literals.

const project = function (url: string, driver?: string): string {
  const root = mkdtempSync(join(tmpdir(), "reylo-compiled-"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, ".env"), `DATABASE_URL=${url}\n`);
  if (driver) {
    mkdirSync(join(root, "node_modules"));
    symlinkSync(join(DRIVERS, driver), join(root, "node_modules", driver));
  }
  return root;
};

/** The module a build step writes for `raw`, imported: its default export and its `sql` and `raw` exports. */
const built = async function (root: string, name: string, raw: string) {
  const file = join(root, `${name}.sql`);
  await writeFile(file, raw);
  const { code } = await sqlModule(file, raw);
  const out = join(root, `${name}.mjs`);
  await writeFile(out, code.replace(`from "@totto2727/reylo"`, `from ${JSON.stringify(INDEX)}`));
  return (await import(pathToFileURL(out).href)) as { default: { sql: string; raw: string; "~standard": { query: { text: string } }; run(client: unknown, params?: unknown): Promise<unknown> }; sql: string; raw: string };
};

/** The declaration's lines that carry the two texts, their doc comments left out. */
const texts = function (declaration: string): string[] {
  return declaration.split("\n").filter((line) => /^export declare const (?:sql|raw):|^ {2}readonly (?:sql|raw|source):/u.test(line) || line.startsWith("declare const query:")).map((line) => line.replace(/^declare const query: Query<.*> & /, "declare const query: Query<…> & "));
};

const GET_USER = "select id, name, email from users where id = :id\n";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a query defined by hand: `raw` is its statement as written and `sql` the one the run time compiles from it", () => {
  const raw = "select :id as id, :name as name, :id as again";
  const pg = defineQuery({ dialect: "postgres", sql: raw, params: ["id", "name"] });
  assert.equal(pg.raw, raw);
  assert.equal(pg.sql, "select $1 as id, $2 as name, $1 as again");
  Iterator.from(["mysql", "sqlite"] as const).forEach((dialect) => {
    const query = defineQuery({ dialect, sql: raw, params: ["id", "name"] });
    assert.equal(query.raw, raw);
    assert.equal(query.sql, "select ? as id, ? as name, ? as again");
  });
  // The compiled text a build step writes wins over the run time's own lexer.
  assert.equal(defineQuery({ dialect: "postgres", sql: "select :id", params: ["id"], text: "select $1::int", order: ["id"] }).sql, "select $1::int");
  // A placeholder its params miss fails where `sql` is read, as `run` does.
  const missing = defineQuery({ dialect: "postgres", sql: "select :id, :other", params: ["id"] });
  assert.equal(missing.raw, "select :id, :other");
  assert.throws(() => missing.sql, /The statement's placeholder :other is parameter "other", which the query's params \(\["id"\]\) do not list/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: `sql` is the compiled statement and `raw` the file, at run time and in the mapper's declaration", async () => {
  const root = project("file:./app.db");
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table users (id integer primary key, name text not null, email text)");
  db.exec("insert into users (name, email) values ('Ada', 'ada@example.com')");
  const doc = `select json_extract(:doc::json, '$.a') as a, :tags::json('{ "type": "array", "items": { "type": "string" } }') as tags\n`;
  try {
    const getUser = await built(root, "get_user", GET_USER);
    assert.equal(getUser.default.sql, "select id, name, email from users where id = ?");
    // The statement Reylo sends ends with the comment naming the file, which `sql` leaves out.
    assert.equal(getUser.default["~standard"].query.text, "select id, name, email from users where id = ? /*file='get_user.sql'*/");
    assert.equal(getUser.default.raw, GET_USER);
    assert.equal(getUser.sql, getUser.default.sql);
    assert.equal(getUser.raw, GET_USER);
    assert.deepEqual({ ...((await getUser.default.run(db, { id: 1 })) as object) }, { email: "ada@example.com", id: 1, name: "Ada" });
    const json = await built(root, "doc", doc);
    assert.equal(json.default.sql, "select json_extract(json(?), '$.a') as a, ? as tags");
    assert.equal(json.default.raw, doc);
    assert.deepEqual({ ...((await json.default.run(db, { doc: { a: 5 }, tags: ["x"] })) as object) }, { a: 5, tags: '["x"]' });
    await closeSessions();
    const declared = await declarations(root, { "get_user.sql": GET_USER, "doc.sql": doc });
    assert.deepEqual(texts(declared["get_user.sql"]!), [
      `export declare const sql: "select id, name, email from users where id = ?";`,
      `export declare const raw: "select id, name, email from users where id = :id\\n";`,
      `declare const query: Query<…> & {`,
      `  readonly sql: typeof sql;`,
      `  readonly raw: typeof raw;`,
      `  readonly source: string;`,
    ]);
    // The query's doc comment is the statement as written; `sql` and `raw` carry none, so a hover
    // Over either shows its text once, as its type.
    assert.ok(requireFixtureValue(declared["get_user.sql"]).includes("/**\n * ```sql\n * select id, name, email from users where id = :id\n * ```\n */\ndeclare const query:"), declared["get_user.sql"]!);
    assert.equal(requireFixtureValue(declared["get_user.sql"]).split("/**").length, 2, declared["get_user.sql"]!);
    // The parameters are one object type, with no tuple beside it.
    const lines = requireFixtureValue(declared["get_user.sql"]).split("\n");
    assert.ok(lines.includes("export type Params = { id: number };"), declared["get_user.sql"]!);
    assert.ok(!lines.some((line) => line.startsWith("export type Values")), declared["get_user.sql"]!);
    assert.match(lines.find((line) => line.startsWith("declare const query:"))!, /^declare const query: Query<\{ id: number \}, \{ id: number; name: string; email: string \| null \}, "maybeOne", "sqlite", QueryError> & /u);
    assert.deepEqual(texts(declared["doc.sql"]!).slice(0, 2), [`export declare const sql: ${JSON.stringify(json.default.sql)};`, `export declare const raw: ${JSON.stringify(doc)};`]);
  } finally {
    db.close();
    await closeSessions();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a statement that fires no trigger declares its QueryError narrowed to the keys and columns it writes through, and one that fires one the whole of it", async () => {
  const root = project("file:./app.db");
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec(`
    create table users (id integer primary key, email text unique not null);
    create table audited (id integer primary key, n integer);
    create trigger audited_audit after insert on audited begin update audited set n = 1 where id = new.id; end;
  `);
  db.close();
  const insert = "insert into users (email) values (:email)\n";
  const audited = "insert into audited (id) values (:id)\n";
  try {
    const declared = await declarations(root, { "insert_user.sql": insert, "insert_audited.sql": audited });
    const queryError = (file: string): string | undefined => requireFixtureValue(/^export type QueryError = ([\s\S]*?>);$/m.exec(declared[file]!))[1];
    assert.equal(queryError("insert_user.sql"), [
      `import("@totto2727/reylo").SqliteQueryError<{`,
      `  "SQLITE_CONSTRAINT": { columns: readonly ["email"] | readonly ["id"] | readonly ["rowid"]; table: "users" };`,
      `  "SQLITE_CONSTRAINT_NOTNULL": { columns: readonly ["email"] | readonly ["id"]; table: "users" };`,
      `  "SQLITE_CONSTRAINT_PRIMARYKEY": { columns: readonly ["id"]; table: "users" };`,
      `  "SQLITE_CONSTRAINT_ROWID": { columns: readonly ["rowid"]; table: "users" };`,
      `  "SQLITE_CONSTRAINT_UNIQUE": { columns: readonly ["email"]; table: "users" };`,
      `}>`,
    ].join("\n"));
    assert.equal(queryError("insert_audited.sql"), `import("@totto2727/reylo").QueryError<"sqlite">`);
  } finally {
    await closeSessions();
  }
});




// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the comment naming the file is sent and left out of sql, sqlcommenter: false leaves it off, and a running build sees the change", async () => {
  const root = project("file:./app.db");
  await writeFile(join(root, ".reylo.yaml"), "sqlcommenter: false\n");
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table users (id integer primary key, name text not null, email text)");
  db.exec("insert into users (name, email) values ('Ada', 'ada@example.com')");
  try {
    const plain = await built(root, "get_user", GET_USER);
    assert.equal(plain.sql, "select id, name, email from users where id = ?");
    assert.equal(plain.default["~standard"].query.text, "select id, name, email from users where id = ?");
    assert.deepEqual({ ...((await plain.default.run(db, { id: 1 })) as object) }, { email: "ada@example.com", id: 1, name: "Ada" });
    const declared = await declarations(root, { "get_user.sql": GET_USER });
    assert.ok(texts(declared["get_user.sql"]!).includes(`export declare const sql: "select id, name, email from users where id = ?";`), declared["get_user.sql"]!);
    // The same process, after the project file turns it back on: the session it builds with is a
    // New one, and the statement it sends ends with the comment, which `sql` leaves out.
    await writeFile(join(root, ".reylo.yaml"), "sqlcommenter: true\n");
    const tagged = await built(root, "get_user_again", GET_USER);
    assert.equal(tagged.sql, "select id, name, email from users where id = ?");
    assert.equal(tagged.default["~standard"].query.text, "select id, name, email from users where id = ? /*file='get_user_again.sql'*/");
    assert.deepEqual({ ...((await tagged.default.run(db, { id: 1 })) as object) }, { email: "ada@example.com", id: 1, name: "Ada" });
  } finally {
    db.close();
    await closeSessions();
  }
});
