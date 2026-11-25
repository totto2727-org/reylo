// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Preserve the native subtest and cleanup lifecycle for each parity case.
import type { TestContext } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to await writes and reads through the host filesystem.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
import { Session } from "#reylo-source/analyze.ts";
import { declarations, forEachFixtureInOrder, requireFixtureValue, ROOT, runChild } from "./helpers.ts";

const schema = `schema "main" {}
table "users" {
  schema = schema.main
  column "id" {
    type = integer
    null = false
  }
  column "email" {
    type = text
    null = false
  }
  column "nickname" {
    type = text
    null = true
  }
  primary_key { columns = [column.id] }
  index "users_email" {
    unique = true
    columns = [column.email]
  }
}
table "posts" {
  schema = schema.main
  column "id" {
    type = integer
    null = false
  }
  column "user_id" {
    type = integer
    null = false
  }
  column "title" {
    type = text
    null = false
    default = "untitled"
  }
  primary_key { columns = [column.id] }
  foreign_key "posts_user" {
    columns = [column.user_id]
    ref_columns = [table.users.column.id]
  }
}
`;

const cases = [
  { cardinality: "maybeOne", name: "primary-key", nulls: [false, false, true], params: [false], sql: "select id, email, nickname from users where id = :id" },
  { cardinality: "maybeOne", name: "unique-index", nulls: [false], params: [false], sql: "select id from users where email = :email" },
  { cardinality: "many", name: "left-join", nulls: [false, true], params: [], sql: "select u.id, p.title from users u left join posts p on p.user_id = u.id" },
  { cardinality: "one", name: "aggregate", nulls: [false], params: [], sql: "select count(*) as total from posts" },
  { cardinality: "one", name: "nullable-input", nulls: [false, true], params: [false, false, true], sql: "insert into users (id, email, nickname) values (:id, :email, :nickname) returning id, nickname" },
];

interface Branches { atlasRoot: string; hclRoot: string; root: string }
interface Readers { direct: Session; reference: Session }

const branches = async (testContext: TestContext, sessions: Session[]): Promise<Branches> => {
  const tmp = path.join(ROOT, "tmp");
  await mkdir(tmp, { recursive: true });
  const root = await mkdtemp(path.join(tmp, "reylo-hcl-parity-"));
  testContext.after(async () => {
    try {
      await forEachFixtureInOrder(sessions, async (session) => {await session.close();});
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
  return { atlasRoot: path.join(root, "atlas"), hclRoot: path.join(root, "hcl"), root };
};

const initialize = async ({ atlasRoot, hclRoot, root }: Branches): Promise<void> => {
  await forEachFixtureInOrder([atlasRoot, hclRoot], async (directory) => {
    await mkdir(directory);
    await writeFile(path.join(directory, "package.json"), "{}");
  });
  await writeFile(path.join(hclRoot, "schema.hcl"), schema);
  // Only the reference branch runs Atlas and creates the local comparison database.
  const applied = await runChild("atlas", ["schema", "apply", "--url", "sqlite://atlas/app.db", "--to", "file://hcl/schema.hcl", "--auto-approve"], { cwd: root, timeout: 60_000 });
  assert.equal(applied.status, 0, `Atlas schema apply failed:\n${applied.stdout}\n${applied.stderr}`);
  await writeFile(path.join(atlasRoot, ".reylo.yaml"), "direct_url: file:./app.db\n");
  await writeFile(path.join(hclRoot, ".reylo.yaml"), "direct_url: hcl:./schema.hcl\n");
};

const readers = async ({ atlasRoot, hclRoot }: Branches, sessions: Session[]): Promise<Readers> => {
  const reference = await Session.open(atlasRoot, {});
  sessions.push(reference);
  const direct = await Session.open(hclRoot, {});
  sessions.push(direct);
  return { direct, reference };
};

const parity = async ({ direct, reference }: Readers, scenario: typeof cases[number]): Promise<void> => {
  const expected = await reference.analyze(scenario.sql);
  const actual = await direct.analyze(scenario.sql);
  assert.ok(expected.ok, JSON.stringify(expected));
  assert.ok(actual.ok, JSON.stringify(actual));
  assert.deepEqual(expected.analysis.diagnostics, []);
  assert.deepEqual(actual.analysis.diagnostics, []);
  assert.equal(expected.analysis.cardinality, scenario.cardinality);
  assert.deepEqual(expected.analysis.columns.map((column) => column.nullable), scenario.nulls);
  assert.deepEqual(expected.analysis.params.map((param) => param.nullable), scenario.params);
  assert.deepEqual(
    { cardinality: actual.analysis.cardinality, columns: actual.analysis.columns, params: actual.analysis.params },
    { cardinality: expected.analysis.cardinality, columns: expected.analysis.columns, params: expected.analysis.params },
  );
};

// Compare only the parameter and result declarations, independent of driver errors or comments.
const types = (text: string): string[] =>
  text.split("\n").filter((line) => /^(?:export type (?:Params|Row) =|declare const query: Query<)/u.test(line));

const declarationParity = async ({ atlasRoot, hclRoot }: Branches): Promise<void> => {
  const files = Object.fromEntries(cases.map(({ name, sql }) => [`${name}.sql`, sql]));
  const expected = await declarations(atlasRoot, files);
  const actual = await declarations(hclRoot, files);
  Object.keys(files).forEach((name) => {
    const emitted = types(requireFixtureValue(actual[name]));
    assert.equal(emitted.length, 3, name);
    assert.deepEqual(emitted, types(requireFixtureValue(expected[name])), name);
  });
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("direct HCL query types match the same schema applied by Atlas", { timeout: 120_000 }, async (testContext) => {
  const sessions: Session[] = [];
  const fixture = await branches(testContext, sessions);
  await initialize(fixture);
  const sessionsByBranch = await readers(fixture, sessions);
  await forEachFixtureInOrder(cases, async (scenario) => {
    await testContext.test(scenario.name, async () => {await parity(sessionsByBranch, scenario);});
  });
  await testContext.test("content mapper exposes identical input and result declarations", async () => {
    await declarationParity(fixture);
  });
});
