// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Change the actual project configuration while the mapper is running.
import { writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the configuration file under the temporary project.
import path from "node:path";
import { defineQuery } from "#reylo-source/index.ts";
import { isRecord, matchesString } from "#reylo-source/native-predicates.ts";
import { closeSessions, declarations, importSqliteQueryFixture, requireFixtureValue } from "./helpers.ts";
import { buildSqliteQueryModule, withProject } from "./sqlite-project-fixture.ts";
import type { SqliteProjectFixture } from "./sqlite-project-fixture.ts";

// A query's `sql` is the statement as Reylo sends it to the database, the engine's compiled text,
// And `raw` the file as written. Both are the module's exports too,
// And the content mapper declares both as string literals.

interface BuiltModule {
  query: Awaited<ReturnType<typeof importSqliteQueryFixture>>;
  raw: string;
  sql: string;
}

const built = async (root: string, name: string, source: string): Promise<BuiltModule> => {
  const url = await buildSqliteQueryModule(root, name, source);
  const module: unknown = await import(url.href);
  assert.ok(isRecord(module) && matchesString(module.raw) && matchesString(module.sql));
  const query = await importSqliteQueryFixture(url.href);
  assert.equal(query, module.default);
  return { query, raw: module.raw, sql: module.sql };
};

const row = (result: unknown): Record<string, unknown> => {
  assert.ok(isRecord(result));
  return { ...result };
};

// The declaration lines for the two texts, with their doc comments omitted.
const texts = function (declaration: string): string[] {
  return declaration.split("\n").filter((line) => /^export declare const (?:sql|raw):|^ {2}readonly (?:sql|raw|source):/u.test(line) || line.startsWith("declare const query:")).map((line) => line.replace(/^declare const query: Query<.*> & /u, "declare const query: Query<…> & "));
};

const GET_USER = "select id, name, email from users where id = :id\n";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a query defined by hand: `raw` is its statement as written and `sql` the one the run time compiles from it", () => {
  const raw = "select :id as id, :name as name, :id as again";
  const pg = defineQuery({ dialect: "postgres", params: ["id", "name"], sql: raw });
  assert.equal(pg.raw, raw);
  assert.equal(pg.sql, "select $1 as id, $2 as name, $1 as again");
  Iterator.from(["mysql", "sqlite"] as const).forEach((dialect) => {
    const query = defineQuery({ dialect, params: ["id", "name"], sql: raw });
    assert.equal(query.raw, raw);
    assert.equal(query.sql, "select ? as id, ? as name, ? as again");
  });
  // The compiled text a build step writes wins over the run time's own lexer.
  assert.equal(defineQuery({ dialect: "postgres", order: ["id"], params: ["id"], sql: "select :id", text: "select $1::int" }).sql, "select $1::int");
  // A placeholder its params miss fails where `sql` is read, as `run` does.
  const missing = defineQuery({ dialect: "postgres", params: ["id"], sql: "select :id, :other" });
  assert.equal(missing.raw, "select :id, :other");
  assert.throws(() => missing.sql, /The statement's placeholder :other is parameter "other", which the query's params \(\["id"\]\) do not list/u);
});

const USER_SCHEMA = `create table users (id integer primary key, name text not null, email text);
insert into users (name, email) values ('Ada', 'ada@example.com');`;
const doc = `select json_extract(:doc::json, '$.a') as a, :tags::json('{ "type": "array", "items": { "type": "string" } }') as tags\n`;

const SQL_FILES = Object.fromEntries([["get_user.sql", GET_USER], ["doc.sql", doc]]);

const assertGetUser = async ({ database, root }: SqliteProjectFixture): Promise<void> => {
  const getUser = await built(root, "get_user", GET_USER);
  assert.equal(getUser.query.sql, "select id, name, email from users where id = ?");
  // The statement Reylo sends ends with the comment naming the file, which `sql` leaves out.
  assert.equal(getUser.query["~standard"].query.text, "select id, name, email from users where id = ? /*file='get_user.sql'*/");
  assert.equal(getUser.query.raw, GET_USER);
  assert.equal(getUser.sql, getUser.query.sql);
  assert.equal(getUser.raw, GET_USER);
  assert.deepEqual(row(await getUser.query.run(database, { id: 1 })), { email: "ada@example.com", id: 1, name: "Ada" });
};

const assertJsonRuntime = async ({ database, root }: SqliteProjectFixture): Promise<string> => {
  const json = await built(root, "doc", doc);
  assert.equal(json.query.sql, "select json_extract(json(?), '$.a') as a, ? as tags");
  assert.equal(json.query.raw, doc);
  assert.deepEqual(row(await json.query.run(database, { doc: { a: 5 }, tags: ["x"] })), { a: 5, tags: '["x"]' });
  return json.query.sql;
};

const checkUserDeclaration = (user: string): void => {
  // The query's doc comment is the statement as written; `sql` and `raw` carry none, so a hover
  // Over either shows its text once, as its type.
  assert.ok(user.includes("/**\n * ```sql\n * select id, name, email from users where id = :id\n * ```\n */\ndeclare const query:"), user);
  assert.equal(user.split("/**").length, 2, user);
  // The parameters are one object type, with no tuple beside it.
  const lines = user.split("\n");
  assert.ok(lines.includes("export type Params = { id: number };"), user);
  assert.ok(!lines.some((line) => line.startsWith("export type Values")), user);
  assert.match(requireFixtureValue(lines.find((line) => line.startsWith("declare const query:"))), /^declare const query: Query<\{ id: number \}, \{ id: number; name: string; email: string \| null \}, "maybeOne", "sqlite", QueryError> & /u);
};

const assertMappedTexts = async (root: string, jsonSql: string): Promise<void> => {
  const declared = await declarations(root, SQL_FILES);
  const user = requireFixtureValue(declared["get_user.sql"]);
  assert.deepEqual(texts(user), [
    `export declare const sql: "select id, name, email from users where id = ?";`,
    `export declare const raw: "select id, name, email from users where id = :id\\n";`,
    `declare const query: Query<…> & {`,
    `  readonly sql: typeof sql;`,
    `  readonly raw: typeof raw;`,
    `  readonly source: string;`,
  ]);
  checkUserDeclaration(user);
  assert.deepEqual(texts(requireFixtureValue(declared["doc.sql"])).slice(0, 2), [`export declare const sql: ${JSON.stringify(jsonSql)};`, `export declare const raw: ${JSON.stringify(doc)};`]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: `sql` is the compiled statement and `raw` the file, at run time and in the mapper's declaration", async () => {
  await withProject(USER_SCHEMA, async (fixture) => {
    await assertGetUser(fixture);
    const jsonSql = await assertJsonRuntime(fixture);
    await closeSessions();
    await assertMappedTexts(fixture.root, jsonSql);
  });
});

const AUDIT_SCHEMA = `
    create table users (id integer primary key, email text unique not null);
    create table audited (id integer primary key, n integer);
    create trigger audited_audit after insert on audited begin update audited set n = 1 where id = new.id; end;
  `;

const assertTriggerDeclarations = async (root: string): Promise<void> => {
  const insert = "insert into users (email) values (:email)\n";
  const audited = "insert into audited (id) values (:id)\n";
  const files = Object.fromEntries([["insert_user.sql", insert], ["insert_audited.sql", audited]]);
  const declared = await declarations(root, files);
  const queryError = (file: string): string | undefined => {
    const source = requireFixtureValue(declared[file]);
    return /^export type QueryError = (?<type>[\s\S]*?>);$/mu.exec(source)?.groups?.type;
  };
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
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a statement that fires no trigger declares its QueryError narrowed to the keys and columns it writes through, and one that fires one the whole of it", async () => {
  await withProject(AUDIT_SCHEMA, async ({ database, root }) => {
    database.close();
    await assertTriggerDeclarations(root);
  });
});

const assertEnabledCommenter = async ({ database, root }: SqliteProjectFixture): Promise<void> => {
  // The same process, after the project file turns it back on: the session it builds with is a
  // New one, and the statement it sends ends with the comment, which `sql` leaves out.
  await writeFile(path.join(root, ".reylo.yaml"), "sqlcommenter: true\n");
  const tagged = await built(root, "get_user_again", GET_USER);
  assert.equal(tagged.sql, "select id, name, email from users where id = ?");
  assert.equal(tagged.query["~standard"].query.text, "select id, name, email from users where id = ? /*file='get_user_again.sql'*/");
  assert.deepEqual(row(await tagged.query.run(database, { id: 1 })), { email: "ada@example.com", id: 1, name: "Ada" });
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the comment naming the file is sent and left out of sql, sqlcommenter: false leaves it off, and a running build sees the change", async () => {
  await withProject(USER_SCHEMA, async ({ database, root }) => {
    await writeFile(path.join(root, ".reylo.yaml"), "sqlcommenter: false\n");
    const plain = await built(root, "get_user", GET_USER);
    assert.equal(plain.sql, "select id, name, email from users where id = ?");
    assert.equal(plain.query["~standard"].query.text, "select id, name, email from users where id = ?");
    assert.deepEqual(row(await plain.query.run(database, { id: 1 })), { email: "ada@example.com", id: 1, name: "Ada" });
    const declared = await declarations(root, { "get_user.sql": GET_USER });
    const source = requireFixtureValue(declared["get_user.sql"]);
    assert.ok(texts(source).includes(`export declare const sql: "select id, name, email from users where id = ?";`), source);
    await assertEnabledCommenter({ database, root });
  });
});
