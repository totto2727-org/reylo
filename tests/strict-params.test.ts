// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Write real mapper project files in an isolated temporary directory.
import { mkdtemp, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Locate temporary fixtures outside the repository.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the independent database and mapper project files.
import path from "node:path";
import { forEachFixtureInOrder, requireFixtureValue, transform } from "./helpers.ts";
import { withProject } from "./sqlite-project-fixture.ts";

// A parameter nothing in the statement types is error reylo12 in the type check unless the project
// File says `strict_params: false`. The content
// Mapper runs as the type check runs it, through its own JSON-RPC process.

interface ReyloConfig { file?: string; source: string }
const project = async (url: string, config?: ReyloConfig): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "reylo-strict-"));
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, ".env"), `DATABASE_URL=${url}\n`);
  if (config) {await writeFile(path.join(root, config.file ?? ".reylo.yaml"), config.source);}
  return root;
};

const mapper = async (url: string, sql: Record<string, string>, config?: ReyloConfig): ReturnType<typeof transform> =>
  transform(await project(url, config), sql);

const message = (written: string, file = ".reylo.yaml"): string => `Nothing in the statement gives the parameter ${written} a type; cast it, as in ${written}::text, or set strict_params: false in ${file}.`;

const checkTypedCasts = async (url: string): Promise<void> => {
  // A statement the engine refused keeps its own error alone: a parameter written twice is untyped
  // Because the analysis stopped there.
  const repeated = await mapper(url, { "repeated.sql": "select :q as a, :q as b\n" });
  assert.deepEqual(requireFixtureValue(repeated["repeated.sql"]).diagnostics.map((diagnostic) => diagnostic.code), [3]);
  // The cast the message suggests types it.
  const cast = await mapper(url, { "cast.sql": "select :x::text as x\n" });
  assert.deepEqual(requireFixtureValue(cast["cast.sql"]).diagnostics, []);
  const json = await mapper(url, { "cast.sql": "select :x::text as x\n", "json.sql": "select json_extract(:doc::json, '$.a') as a\n" });
  assert.deepEqual(requireFixtureValue(json["json.sql"]).diagnostics, []);
  assert.deepEqual(requireFixtureValue(json["cast.sql"]).diagnostics, []);
};

const checkStrictness = async (url: string): Promise<void> => {
  // SQLite types no bare parameter in a select list: by default each is an error at its first use.
  const sql = { "bare.sql": "select :x as x, :y as y\n" };
  const strict = await mapper(url, sql);
  assert.deepEqual(requireFixtureValue(strict["bare.sql"]).diagnostics, [
    { code: 12, length: 2, messageText: message(":x"), start: 7 },
    { code: 12, length: 2, messageText: message(":y"), start: 16 },
  ]);
  // A project file without the key takes the default too, and so does `strict_params: true`.
  await forEachFixtureInOrder(["env: [.env]\n", "strict_params: true\n"], async (source) => {
    const output = await mapper(url, sql, { source });
    const { diagnostics } = requireFixtureValue(output["bare.sql"]);
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), [12, 12], source);
  });
  // A project whose file is `.reylo.yml` is told to set the key there, not in a `.reylo.yaml` it lacks.
  const yml = await mapper(url, sql, { file: ".reylo.yml", source: "strict_params: true\n" });
  assert.deepEqual(requireFixtureValue(yml["bare.sql"]).diagnostics.map((diagnostic) => diagnostic.messageText), [message(":x", ".reylo.yml"), message(":y", ".reylo.yml")]);
  // `strict_params: false` keeps such a parameter `unknown`, with no error.
  const loose = await mapper(url, sql, { source: "strict_params: false\n" });
  assert.deepEqual(requireFixtureValue(loose["bare.sql"]).diagnostics, []);
  assert.match(requireFixtureValue(loose["bare.sql"]).text, /export type Params = \{ x: unknown; y: unknown \}/u);
  await checkTypedCasts(url);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a parameter nothing types is an error by default, and strict_params: false keeps it unknown", async () => {
  await withProject("create table users (id integer primary key)", async ({ database, root }) => {
    database.close();
    await checkStrictness(`file:${path.join(root, "app.db")}`);
  });
});


const sorted = "select id, name from users order by :sort::text\n";
const grouped = "select count(*) as n from users group by :g\n";
const chosen = "select id, name from users order by case :sort::text when 'name' then name end, id\n";

const sortQueries = Object.fromEntries([
  ["sorted.sql", sorted], ["grouped.sql", grouped], ["chosen.sql", chosen],
]);

const checkOrderAndGroup = async (url: string): Promise<void> => {
  const out = await mapper(url, sortQueries);
  const why = "since a parameter is a value and not a column's name; choose the column with";
  assert.deepEqual(requireFixtureValue(out["sorted.sql"]).diagnostics, [{ code: 17, length: ":sort::text".length, messageText: `order by :sort sorts every row by the same value, ${why} case :sort when 'name' then name end`, start: sorted.indexOf(":sort") }]);
  assert.match(requireFixtureValue(out["sorted.sql"]).text, /export type Params = \{ sort: string \}/u);
  assert.match(requireFixtureValue(out["sorted.sql"]).text, /export type Row = \{ id: number; name: string \}/u);
  // A parameter nothing else types stays unknown with no second error: the key is the one to fix.
  assert.deepEqual(requireFixtureValue(out["grouped.sql"]).diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.start, diagnostic.messageText]), [[17, grouped.indexOf(":g"), `group by :g puts every row in one group, ${why} case :g when 'name' then name end`]]);
  assert.match(requireFixtureValue(out["grouped.sql"]).text, /export type Row = \{ n: number \}/u);
  // The case the message suggests chooses the column with the parameter.
  assert.deepEqual(requireFixtureValue(out["chosen.sql"]).diagnostics, []);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a parameter as a whole sort or group key is error reylo17 at the parameter, and the statement is typed all the same", async () => {
  await withProject("create table users (id integer primary key, name text not null)", async ({ database, root }) => {
    database.close();
    await checkOrderAndGroup(`file:${path.join(root, "app.db")}`);
  });
});
