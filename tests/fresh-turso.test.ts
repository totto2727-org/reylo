// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite using Node's integration test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Match the native driver's rows and failures exactly.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Read the emitted module and detect the optional installed lab adapter.
import { access, readFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the optional Turso package through the lab's installed dependencies.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- Resolve fixture files relative to their real filesystem directories.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Import the generated query and optional adapter from their filesystem URLs.
import { pathToFileURL } from "node:url";
import type { TursoClient } from "#reylo-source/execute.ts";
import { hasFunctionType, isRecord, matchesString } from "#reylo-source/native-predicates.ts";
import { DRIVERS, SQL_NULL, requireFixtureValue } from "./helpers.ts";
import { importBuiltSqliteQuery as built, withProject } from "./sqlite-project-fixture.ts";

const TURSO = "@tursodatabase/database";
const tursoSkip = async (): Promise<false | string> => {
  try {
    await access(path.join(DRIVERS, TURSO));
    return false;
  } catch {
    return "lab/drivers is not installed";
  }
};

const TURSO_SKIP = await tursoSkip();

interface TursoFixtureClient extends TursoClient {
  close: () => Promise<void>;
  prepare: (sql: string) => { all: () => Promise<unknown[]> };
}

const connectTurso = async function (file: string): Promise<TursoFixtureClient> {
  const require = createRequire(path.join(DRIVERS, "package.json"));
  const driver: unknown = await import(pathToFileURL(require.resolve(TURSO)).href);
  assert.ok(isRecord(driver) && hasFunctionType(driver.connect));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The optional lab package supplies the native Turso connect contract at runtime.
  const connect = driver.connect as (filename: string) => Promise<TursoFixtureClient>;
  return connect(file);
};

const installedColumnTypes = async function (root: string, database: TursoFixtureClient): Promise<void> {
  const read = await built(root, "read", "select id, email, n, ok from users order by id");
  const builtSource = await readFile(path.join(root, "read.mjs"), "utf8");
  const factsGroup = /"rows":(?<facts>\[\[.*?\]\]),"inserts"/u.exec(builtSource)?.groups?.facts;
  const facts: unknown = JSON.parse(requireFixtureValue(factsGroup));
  assert.ok(Array.isArray(facts) && facts.every((row) => Array.isArray(row) && row.every((field) => matchesString(field))));
  assert.deepEqual(facts.map((row) => row[2]), ["TEXT", "INTEGER", "bigInt", "boolean"], "the facts node:sqlite gave the build, the names it knows upper-cased");
  const columns = await database.prepare("select type from pragma_table_xinfo('users')").all();
  const types = columns.map((column) => {
    assert.ok(isRecord(column) && matchesString(column.type));
    return column.type;
  });
  assert.deepEqual(types, ["integer", "text", "bigInt", "boolean"], "the control: Turso's engine gives each type as declared");
  assert.deepEqual(await read.run(database), [{ email: "a@x", id: 1, n: BigInt("7"), ok: true }]);
};

const checkTursoDefaultsAndRename = async function (root: string, database: TursoFixtureClient): Promise<void> {
  // Turso evaluates the SQLite defaults copied by the build, including rows that omit different keys.
  const insert = await built(root, "insert", "insert into accounts :a::rows(name text not null, role? text not null, tok? text not null, n integer) returning id, role, n");
  assert.deepEqual(await insert.run(database, { a: [{ name: "Ada" }, { n: SQL_NULL, name: "Grace", role: "admin", tok: "t" }] }), [{ id: 1, n: -7, role: "member" }, { id: 2, n: SQL_NULL, role: "admin" }]);
  const read = await built(root, "read2", "select id, email from users order by id");
  await database.exec("alter table users rename column email to mail");
  await assert.rejects(read.run(database), /The database changed after read2\.sql was built: users\.email was TEXT not null and no longer exists\. Build it again/u);
};

const TURSO_SCHEMA = `create table users (id integer primary key, email text not null, n bigInt, ok boolean);
insert into users (email, n, ok) values ('a@x', 7, 1);
create table accounts (id integer primary key, name text not null, role text not null default member, tok text not null default (lower(hex(randomblob(4)))), n integer default -7);`;

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite on Turso's engine: a query built on node:sqlite runs, whose types Turso spells in lowercase, and a column it names, renamed, fails the call", { skip: TURSO_SKIP }, async () => {
  await withProject(TURSO_SCHEMA, async ({ database, root }) => {
    database.close();
    const turso = await connectTurso(path.join(root, "app.db"));
    try {
      await installedColumnTypes(root, turso);
      await checkTursoDefaultsAndRename(root, turso);
    } finally {
      await turso.close();
    }
  });
});
