// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Execute the mapped query through the native database in the fixture project.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the same SQLite database that TypeScript inspected.
import path from "node:path";
import { reyloImport } from "#reylo-source/module-types.ts";
import { isRecord } from "#reylo-source/native-predicates.ts";
import { declarations, requireFixtureValue, SQL_NULL } from "./helpers.ts";
import { importBuiltSqliteQuery } from "./sqlite-project-fixture.ts";
import { typeCheck, withCompilerProject, writeSql, writeTypeScript } from "./tsc-project-fixture.ts";

const QUERY_ONLY = `import type { Query } from "@totto2727/reylo";`;
const WITH_JSON = `import type { Json, Query } from "@totto2727/reylo";`;

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a module imports Json only where one of its types names it", () => {
  assert.equal(reyloImport("{ stage: Json }", "{ id: number }"), WITH_JSON);
  assert.equal(reyloImport("Record<never, never>", "{ tags: Json[]; doc: Record<string, Json>; g: { type: string; [key: string]: Json | undefined } }"), WITH_JSON);
  assert.equal(reyloImport("{ Json: number; Jsonb?: string }", `{ kind: "Json" | "a Json b" }`), QUERY_ONLY);
  assert.equal(reyloImport("Record<never, never>", "{\n  /** the Json payload */\n  id: number;\n}"), QUERY_ONLY);
  assert.equal(reyloImport("Record<never, never>", `{ "/*": number; data: Json; "*/": number }`), WITH_JSON);
  assert.equal(reyloImport("Record<never, never>", `{\n  /** a " quote */\n  data: Json;\n  /** another " */\n  id: number;\n}`), WITH_JSON);
  assert.equal(reyloImport("Record<never, never>", `{\n  /** a " quote */\n  id: number;\n  /** Json" */\n  n: number;\n}`), QUERY_ONLY);
});

const files = {
  "built.sql": "select json_object('k', json_extract(doc, '$.a'), 'n', id) as f from docs\n",
  "plain.sql": "select json_object('Json', id) as Json from docs\n",
};

const keep = `select coalesce(:doc::json, json('"kept"')) as doc, coalesce(:keep::nullable(json), json('"kept"')) as keep\n`;

const assertImportedTypes = async (root: string): Promise<void> => {
  await writeSql(root, files);
  const declared = await declarations(root, files);
  assert.deepEqual(requireFixtureValue(declared["built.sql"]).split("\n").slice(0, 3), [WITH_JSON, "export type Params = Record<never, never>;", "export type Row = { f: { k: Json; n: number } };"]);
  assert.deepEqual(requireFixtureValue(declared["plain.sql"]).split("\n").slice(0, 3), [QUERY_ONLY, "export type Params = Record<never, never>;", "export type Row = { Json: { Json: number } };"]);
  await writeTypeScript(root, [
    `import type { Json } from "@totto2727/reylo";`,
    `import type { Row } from "./built.sql";`,
    `import type { Row as Plain } from "./plain.sql";`,
    `declare const row: Row;`,
    `declare const plain: Plain;`,
    `export const k: Json = row.f.k;`,
    `export const n: number = row.f.n;`,
    `// @ts-expect-error a JSON value is no string until it is narrowed`,
    `export const s: string = row.f.k;`,
    `export const narrowed: string | undefined = typeof row.f.k === "string" ? row.f.k : undefined;`,
    `export const key: number = plain.Json.Json;`,
    "",
  ].join("\n"));
  const result = await typeCheck(root);
  assert.equal(result.stdout + result.stderr, "");
  assert.equal(result.status, 0);
};

// oxlint-disable-next-line unicorn/no-null -- The non-nullable JSON parameter encodes the JSON literal null.
const JSON_NULL = null;

const assertNullableJson = async (root: string): Promise<void> => {
  const declarationsByFile = await declarations(root, { "keep.sql": keep });
  const declaration = requireFixtureValue(declarationsByFile["keep.sql"]);
  assert.deepEqual(declaration.split("\n").filter((line) => /^export type (?:Params|Row) = /u.test(line) || line.startsWith("import type")), [WITH_JSON, "export type Params = { doc: Json; keep?: Json };", "export type Row = { doc: string; keep: string };"]);
  const query = await importBuiltSqliteQuery(root, "keep", keep);
  const database = new DatabaseSync(path.join(root, "app.db"));
  try {
    const result = await query.run(database, { doc: JSON_NULL, keep: SQL_NULL });
    assert.ok(isRecord(result));
    assert.deepEqual({ ...result }, { doc: "null", keep: '"kept"' });
  } finally {
    database.close();
  }
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: untyped JSON values use Json through the content mapper, and JSON null differs from SQL NULL", async () => {
  const schema = "create table docs (id integer primary key, doc text not null)";
  await withCompilerProject({ noUnusedLocals: true, schema }, async (root) => {
    await assertImportedTypes(root);
    await assertNullableJson(root);
  });
});
