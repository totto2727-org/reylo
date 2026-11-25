// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Inspect the generated source and exercise cache use without its database.
import { access, mkdir, rename, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve fixture paths with the host platform's conventions.
import path from "node:path";
import { Session } from "#reylo-source/analyze.ts";
import type { Outcome } from "#reylo-source/analyze.ts";
import { sqlModule } from "#reylo-source/loader.ts";
import { defineQuery } from "#reylo-source/index.ts";
import { closeSessions, forEachFixtureInOrder, requireFixtureValue } from "./helpers.ts";
import type { EmptyParameters } from "./helpers.ts";
import { querySource, withProject } from "./sqlite-project-fixture.ts";
import type { SqliteProjectFixture } from "./sqlite-project-fixture.ts";

const SCHEMA = "create table users (id integer primary key, name text not null)";
const SELECT = "select id, name from users where id = :id";

const successful = (outcome: Outcome): Extract<Outcome, { ok: true }> => {
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome;
};

const EMITTED = [
  `import { defineQuery } from "@totto2727/reylo";`,
  `export const sql = "select id, name from users where id = ?";`,
  `export const raw = ${JSON.stringify(SELECT)};`,
  `export const params = ["id"];`,
  `export default defineQuery({ dialect: "sqlite", sql: raw, params, cardinality: "maybeOne", text: sql, order: ["id"], inputs: {"id":{"type":{"kind":"scalar","name":"integer"},"nullable":false}}, columns: [["id","int"],["name","text"]], fresh: {"query":"select j.value as fresh_table, p.name as fresh_column, p.type as fresh_type, cast(p.\\"notnull\\" as text) as fresh_not_null, cast(p.dflt_value is not null or (p.pk > 0 and lower(p.type) = 'integer' and (select count(*) from pragma_table_xinfo(j.value) k where k.pk > 0) = 1) as text) as fresh_default from (select 'users' as value) j, pragma_table_xinfo(j.value) p order by 1, 2","rows":[["users","id","INTEGER","0","1"],["users","name","TEXT","1","0"]],"inserts":[]}, source: "user.sql", sqlcommenter: true, jsonSchema: {"input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"id":{"type":"integer","format":"int64"}},"required":["id"],"additionalProperties":false},"output":{"$schema":"https://json-schema.org/draft/2020-12/schema","anyOf":[{"type":"object","properties":{"id":{"type":"integer","format":"int64"},"name":{"type":"string"}},"required":["id","name"]},{"type":"null"}]}} });`,
  ``,
].join("\n");

const checkPlainQuery = async (root: string): Promise<void> => {
  const queries = path.join(root, "queries");
  await mkdir(queries);
  const query = "select 1 as n";
  const filename = await querySource(queries, "one", query);
  const { code } = await sqlModule(filename, query);
  assert.ok(!code.includes("fresh:"));
  assert.ok(code.includes(', source: "queries/one.sql", '));
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the module a build step emits carries the analysis and reads nothing at run time", async () => {
  await withProject(SCHEMA, async ({ database, root }) => {
    database.close();
    const file = await querySource(root, "user", SELECT);
    const { code, entry, watched } = await sqlModule(file, SELECT);
    await access(entry);
    assert.deepEqual(watched, [path.join(root, ".env")]);
    assert.equal(code, EMITTED);
    await checkPlainQuery(root);
    // A build with neither the database nor the entry fails instead of guessing.
    await closeSessions();
    await rename(path.join(root, "app.db"), path.join(root, "gone.db"));
    await assert.rejects(sqlModule(file, "select name from users"), /user\.sql: Cannot open the database .*run reylo generate/u);
  });
});

const DDL = "create index users_name on users (name)";
const PRAGMA = "pragma index_list(users)";

const checkCommandAnalysis = async (session: Session): Promise<void> => {
  const created = successful(await session.analyze(DDL));
  const { cardinality, columns, diagnostics, kind, params } = created.analysis;
  assert.deepEqual({ cardinality, columns, diagnostics, kind, params }, { cardinality: "none", columns: [], diagnostics: [], kind: "create", params: [] });
};

const checkPragmaRows = async (session: Session, database: SqliteProjectFixture["database"]): Promise<void> => {
  const listed = successful(await session.analyze(PRAGMA));
  assert.equal(listed.analysis.cardinality, "many");
  const expected = ["seq", "name", "unique", "origin", "partial"].map((name) => [name, "unknown", true]);
  assert.deepEqual(listed.analysis.columns.map((column) => [column.name, column.type.kind, column.nullable]), expected);
  const readIndexes = defineQuery<EmptyParameters, { name: string }, "many", "sqlite">({ cardinality: "many", dialect: "sqlite", params: [], sql: PRAGMA });
  const rows = await readIndexes.run(database);
  assert.deepEqual(rows.map((row) => row.name), ["users_name"]);
};

const checkExistingTable = async (session: Session): Promise<void> => {
  const result = successful(await session.analyze("create table users (id integer primary key)"));
  assert.deepEqual(result.analysis.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]), [[6, 'table users already exists, so if it is a migration or a schema file, leave it out of the type check with "exclude" in tsconfig.json, as in "exclude": ["db/**"].']]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("one statement of another kind is a command: DDL resolves to nothing and runs, and a PRAGMA returns its rows", async () => {
  await withProject(SCHEMA, async ({ database, root }) => {
    const session = await Session.open(root, { DATABASE_URL: "file:./app.db" });
    await checkCommandAnalysis(session);
    const createIndex = defineQuery<EmptyParameters, never, "none", "sqlite">({ cardinality: "none", dialect: "sqlite", params: [], sql: DDL });
    // oxlint-disable-next-line typescript/no-confusing-void-expression -- Verify the actual undefined value returned by a successful DDL statement.
    const result: unknown = await createIndex.run(database);
    assert.equal(result, undefined);
    await checkPragmaRows(session, database);
    await checkExistingTable(session);
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a build fails on a statement the database refuses, at its line and column as the type check places it", async () => {
  await withProject(SCHEMA, async ({ database, root }) => {
    database.close();
    // The analyzer reports UTF-8 offsets. The build reports a character column after é.
    const sql = "select 'é' as e,\n  nmae from users";
    const file = await querySource(root, "bad", sql);
    await assert.rejects(sqlModule(file, sql), /bad\.sql:2:3: no such column: nmae$/u);
  });
});

const DUPLICATE = "select id, name from users\nwhere name like :q or name = :q or id = :q";
const SINGLE = "with input as (select :q::nullable(text) as q) select id, name from users, input where name like coalesce(input.q, '%') or name = input.q";

const checkRepeated = async (session: Session, root: string): Promise<string> => {
  const outcome = successful(await session.analyze(DUPLICATE));
  const second = DUPLICATE.indexOf(":q or id");
  assert.deepEqual(outcome.analysis.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.start, diagnostic.length]), [[3, second, 2], [3, DUPLICATE.lastIndexOf(":q"), 2]]);
  assert.equal(requireFixtureValue(outcome.analysis.diagnostics[0]).message, "The parameter :q appears more than once; use each parameter once, and select it in a with to read it twice, cast to its type, as in: with input as (select :q::<type> as q) select … from input");
  const file = await querySource(root, "search", DUPLICATE);
  await assert.rejects(sqlModule(file, DUPLICATE), /search\.sql: The parameter :q appears more than once/u);
  return file;
};

const checkNativeNames = async (session: Session): Promise<void> => {
  await forEachFixtureInOrder([
    "select id from users where name = @q or name = @q",
    "select id from users where id = ?1 or id = ?1",
    "select id from users where id = ? or id = ?1",
  ], async (sql) => {
    const refused = successful(await session.analyze(sql));
    assert.deepEqual(refused.analysis.diagnostics.map((diagnostic) => diagnostic.code), [3], sql);
  });
  const bare = successful(await session.analyze("select id from users where id = ? or id = ?"));
  assert.deepEqual(bare.analysis.diagnostics, []);
};

const checkCte = async (session: Session, file: string): Promise<void> => {
  const read = successful(await session.analyze(SINGLE));
  assert.deepEqual(read.analysis.diagnostics, []);
  assert.deepEqual(read.analysis.params.map((parameter) => [parameter.name, parameter.nullable]), [["q", true]]);
  await writeFile(file, SINGLE);
  const { code } = await sqlModule(file, SINGLE);
  assert.match(code, /export const params = \["q"\];/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a parameter written twice is an error at each later use, which the type check places and a build fails on; a with reads the value twice", async () => {
  await withProject(SCHEMA, async ({ database, root }) => {
    database.close();
    const session = await Session.for(root);
    const file = await checkRepeated(session, root);
    await checkNativeNames(session);
    await checkCte(session, file);
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a parameter as a whole sort key is an error the type check places, and a build still runs the statement it typed", async () => {
  await withProject(SCHEMA, async ({ database, root }) => {
    database.close();
    const sql = "select id, name from users\norder by :sort";
    const session = await Session.for(root);
    const outcome = successful(await session.analyze(sql));
    assert.deepEqual(outcome.analysis.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.start, diagnostic.length]), [[17, sql.indexOf(":sort"), 5]]);
    assert.deepEqual(outcome.analysis.columns.map((column) => column.name), ["id", "name"]);
    const file = await querySource(root, "sorted", sql);
    const { code } = await sqlModule(file, sql);
    assert.match(code, /export const params = \["sort"\];/u);
  });
});
