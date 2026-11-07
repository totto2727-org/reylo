import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Session } from "../src/analyze.ts";
import { declarations, ROOT } from "./helpers.ts";

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
  { name: "primary-key", sql: "select id, email, nickname from users where id = :id", cardinality: "maybeOne", nulls: [false, false, true], params: [false] },
  { name: "unique-index", sql: "select id from users where email = :email", cardinality: "maybeOne", nulls: [false], params: [false] },
  { name: "left-join", sql: "select u.id, p.title from users u left join posts p on p.user_id = u.id", cardinality: "many", nulls: [false, true], params: [] },
  { name: "aggregate", sql: "select count(*) as total from posts", cardinality: "one", nulls: [false], params: [] },
  { name: "nullable-input", sql: "insert into users (id, email, nickname) values (:id, :email, :nickname) returning id, nickname", cardinality: "one", nulls: [false, true], params: [false, false, true] },
];

test("direct HCL query types match the same schema applied by Atlas", { timeout: 120_000 }, async (t) => {
  const tmp = join(ROOT, "tmp");
  mkdirSync(tmp, { recursive: true });
  const root = mkdtempSync(join(tmp, "reylo-hcl-parity-"));
  const atlasRoot = join(root, "atlas");
  const hclRoot = join(root, "hcl");
  const sessions: Session[] = [];
  try {
    for (const dir of [atlasRoot, hclRoot]) {
      mkdirSync(dir);
      writeFileSync(join(dir, "package.json"), "{}");
    }
    const source = join(hclRoot, "schema.hcl");
    writeFileSync(source, schema);
    // Only this reference branch runs Atlas or creates a host database.
    const applied = spawnSync("atlas", ["schema", "apply", "--url", "sqlite://atlas/app.db", "--to", "file://hcl/schema.hcl", "--auto-approve"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.ifError(applied.error);
    assert.equal(applied.status, 0, `Atlas schema apply failed:\n${applied.stdout}\n${applied.stderr}`);
    writeFileSync(join(atlasRoot, ".reylo.yaml"), "direct_url: file:./app.db\n");
    writeFileSync(join(hclRoot, ".reylo.yaml"), "direct_url: hcl:./schema.hcl\n");
    const reference = await Session.open(atlasRoot, {});
    sessions.push(reference);
    const direct = await Session.open(hclRoot, {});
    sessions.push(direct);
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const expected = await reference.analyze(scenario.sql);
        const actual = await direct.analyze(scenario.sql);
        assert.ok(expected.ok, JSON.stringify(expected));
        assert.ok(actual.ok, JSON.stringify(actual));
        assert.deepEqual(expected.analysis.diagnostics, []);
        assert.deepEqual(actual.analysis.diagnostics, []);
        assert.equal(expected.analysis.cardinality, scenario.cardinality);
        assert.deepEqual(expected.analysis.columns.map((column) => column.nullable), scenario.nulls);
        assert.deepEqual(expected.analysis.params.map((param) => param.nullable), scenario.params);
        // Compare inferred inputs and results, not catalog SQL, paths or cache provenance.
        assert.deepEqual({ params: actual.analysis.params, columns: actual.analysis.columns, cardinality: actual.analysis.cardinality }, { params: expected.analysis.params, columns: expected.analysis.columns, cardinality: expected.analysis.cardinality });
      });
    }
    await t.test("content mapper exposes identical input and result declarations", async () => {
      const files = Object.fromEntries(cases.map(({ name, sql }) => [`${name}.sql`, sql]));
      const expected = await declarations(atlasRoot, files);
      const actual = await declarations(hclRoot, files);
      for (const name of Object.keys(files)) {
        // Driver-specific errors and documentation are not inferred input/result types.
        const types = (text: string) => text.split("\n").filter((line) => /^(export type (Params|Row) =|declare const query: Query<)/.test(line));
        assert.equal(types(actual[name]!).length, 3, name);
        assert.deepEqual(types(actual[name]!), types(expected[name]!), name);
      }
    });
  } finally {
    for (const session of sessions) await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
