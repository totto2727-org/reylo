import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sqlModule } from "../src/loader.ts";
import { reyloImport } from "../src/module-types.ts";
import { closeSessions, declarations, INDEX, ROOT } from "./helpers.ts";

// A value nothing types inside JSON a statement builds is Json, exported by the runtime.
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const QUERY_ONLY = `import type { Query } from "@totto2727/reylo";`;
const WITH_JSON = `import type { Json, Query } from "@totto2727/reylo";`;

test("a module imports Json only where one of its types names it", () => {
  assert.equal(reyloImport("{ stage: Json }", "{ id: number }"), WITH_JSON);
  assert.equal(reyloImport("Record<never, never>", "{ tags: Json[]; doc: Record<string, Json>; g: { type: string; [key: string]: Json | undefined } }"), WITH_JSON);
  assert.equal(reyloImport("{ Json: number; Jsonb?: string }", `{ kind: "Json" | "a Json b" }`), QUERY_ONLY);
  assert.equal(reyloImport("Record<never, never>", "{\n  /** the Json payload */\n  id: number;\n}"), QUERY_ONLY);
  assert.equal(reyloImport("Record<never, never>", `{ "/*": number; data: Json; "*/": number }`), WITH_JSON);
  assert.equal(reyloImport("Record<never, never>", `{\n  /** a " quote */\n  data: Json;\n  /** another " */\n  id: number;\n}`), WITH_JSON);
  assert.equal(reyloImport("Record<never, never>", `{\n  /** a " quote */\n  id: number;\n  /** Json" */\n  n: number;\n}`), QUERY_ONLY);
});

test("SQLite: untyped JSON values use Json through the content mapper, and JSON null differs from SQL NULL", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reylo-json-")));
  writeFileSync(join(root, "package.json"), `{ "type": "module" }`);
  writeFileSync(join(root, ".env"), "DATABASE_URL=file:./app.db\n");
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table docs (id integer primary key, doc text not null)");
  db.close();
  mkdirSync(join(root, "node_modules", "@totto2727"), { recursive: true });
  symlinkSync(ROOT, join(root, "node_modules", "@totto2727", "reylo"));
  symlinkSync(join(ROOT, "packages", "sqlite"), join(root, "node_modules", "@totto2727", "reylo-sqlite"));
  const compilerOptions = { target: "esnext", module: "nodenext", lib: ["esnext"], types: [], strict: true, noUnusedLocals: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true };
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions, contentMappers: [{ package: "@totto2727/reylo", extensions: [".sql"] }], include: ["main.ts"] }));
  const files = {
    "built.sql": "select json_object('k', json_extract(doc, '$.a'), 'n', id) as f from docs\n",
    "plain.sql": "select json_object('Json', id) as Json from docs\n",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const declared = await declarations(root, files);
  assert.deepEqual(declared["built.sql"]!.split("\n").slice(0, 3), [WITH_JSON, "export type Params = Record<never, never>;", "export type Row = { f: { k: Json; n: number } };"]);
  assert.deepEqual(declared["plain.sql"]!.split("\n").slice(0, 3), [QUERY_ONLY, "export type Params = Record<never, never>;", "export type Row = { Json: { Json: number } };"]);
  writeFileSync(join(root, "main.ts"), [
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
  const r = spawnSync(process.execPath, [TSC, "-p", "tsconfig.json", "--runExternalCode", "--pretty", "false"], { cwd: root, encoding: "utf8" });
  assert.equal(r.stdout + r.stderr, "");
  assert.equal(r.status, 0);
  const keep = `select coalesce(:doc::json, json('"kept"')) as doc, coalesce(:keep::nullable(json), json('"kept"')) as keep\n`;
  const declaration = (await declarations(root, { "keep.sql": keep }))["keep.sql"]!;
  assert.deepEqual(declaration.split("\n").filter((line) => /^export type (Params|Row) = /.test(line) || line.startsWith("import type")), [WITH_JSON, "export type Params = { doc: Json; keep?: Json };", "export type Row = { doc: string; keep: string };"]);
  await closeSessions();
  const lite = new DatabaseSync(join(root, "app.db"));
  try {
    const file = join(root, "keep.sql");
    const { code } = await sqlModule(file, keep);
    const out = join(root, "keep.mjs");
    writeFileSync(out, code.replace(`from "@totto2727/reylo"`, `from ${JSON.stringify(INDEX)}`));
    const { default: query } = await import(pathToFileURL(out).href);
    assert.deepEqual({ ...await query.run(lite, { doc: null, keep: null }) }, { doc: "null", keep: '"kept"' });
  } finally {
    lite.close();
    await closeSessions();
  }
});
