import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Session } from "../src/analyze.ts";
import { sqlModule } from "../src/loader.ts";
import { mapperHandlers } from "../src/mapper-server.ts";
import { hclPath } from "../src/project.ts";
import { hclCatalog } from "../src/hcl.ts";
import { engine } from "../src/engine.ts";

const tmp = fileURLToPath(new URL("../tmp/", import.meta.url));
const INDEX = new URL("../src/index.ts", import.meta.url).href;
const SELECT = "select id, name from users where id = :id";
const schema = (nullable = false) => `schema "main" {}
table "users" {
  schema = schema.main
  column "id" {
    type = integer
    null = false
  }
  column "name" {
    type = text
    null = ${nullable}
  }
  primary_key {
    columns = [column.id]
  }
}
`;

function project() {
  mkdirSync(tmp, { recursive: true });
  const root = mkdtempSync(join(tmp, "reylo-hcl-"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, ".reylo.yaml"), "direct_url: hcl:./schema.hcl\n");
  writeFileSync(join(root, "schema.hcl"), schema());
  return root;
}

test("HCL sources accept only one local .hcl file", () => {
  assert.equal(hclPath("hcl:./schema.hcl", tmp), join(tmp, "schema.hcl"));
  assert.equal(hclPath("HCL:./schema.hcl", tmp), join(tmp, "schema.hcl"));
  assert.equal(hclPath("file:./app.db", tmp), undefined);
  for (const source of ["hcl:", "hcl://remote/schema.hcl", "hcl:./app.db", "hcl:./schema.hcl?mode=rw", "hcl:./schema.hcl#fragment", "hcl:./bad\0schema.hcl"]) assert.throws(() => hclPath(source, tmp), /one local \.hcl file/);
});

test("HCL supplies only static schema rows and embedded function defaults to the engine", async () => {
  const root = project();
  const catalog = hclCatalog(join(root, "schema.hcl"), await engine("sqlite", root));
  try {
    const ddl = "select sql from sqlite_schema where sql is not null and type in ('table', 'view', 'index', 'trigger') order by rowid";
    assert.deepEqual(await catalog.query(ddl, []), [['CREATE TABLE "users" ("id" integer NOT NULL, "name" text NOT NULL, PRIMARY KEY ("id"))']]);
    assert.deepEqual(await catalog.query("select name, narg, type from pragma_function_list", []), []);
    await assert.rejects(catalog.query(ddl, [1]), /do not accept parameters/);
    await assert.rejects(catalog.query("create table unexpected (id text)", []), /Unsupported static HCL catalog request/);
    const analyzed = await catalog.analyze("select upper(name), json_object('id', id) from users where id = :id");
    assert.deepEqual(analyzed.diagnostics, []);
  } finally {
    await catalog.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid static declarations fail before the engine receives a catalog", async () => {
  const root = project();
  const wasm = await engine("sqlite", root);
  try {
    writeFileSync(join(root, "schema.hcl"), schema().replace("type = text", "type = unknown_type"));
    assert.throws(() => hclCatalog(join(root, "schema.hcl"), wasm), /Cannot evaluate HCL schema/);
    // SQL expressions remain input to the existing embedded SQL analyzer, not host execution.
    writeFileSync(join(root, "schema.hcl"), schema().replace("  primary_key {", `  check { expr = ${JSON.stringify("name != ';' /* normal comment */")} }\n  primary_key {`));
    const catalog = hclCatalog(join(root, "schema.hcl"), wasm);
    assert.deepEqual((await catalog.analyze(SELECT)).diagnostics, []);
    await catalog.close();
    assert.ok(!readdirSync(root).some((name) => /\.(db|sqlite)(-|$)/.test(name)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Atlas HCL feeds the real SQLite engine and invalidates warm caches immediately", async () => {
  const root = project();
  const session = await Session.open(root, {});
  try {
    assert.equal(session.project.dialect, "sqlite");
    assert.ok(session.project.watched.includes(join(root, "schema.hcl")));
    const first = await session.analyze(SELECT);
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.source, "database");
    assert.equal(first.analysis.cardinality, "maybeOne");
    assert.deepEqual(first.analysis.columns.map(({ name, nullable }) => [name, nullable]), [["id", false], ["name", false]]);
    assert.deepEqual(first.analysis.params.map(({ name, nullable, type_name }) => [name, nullable, type_name]), [["id", false, "integer"]]);
    const cached = await session.analyze(SELECT);
    assert.ok(cached.ok);
    assert.equal(cached.source, "cache");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'node:sqlite') throw new Error('Host SQLite is forbidden during HCL analysis');
        return nextResolve(specifier, context);
      }});
      const { Session } = await import(${JSON.stringify(new URL("../src/analyze.ts", import.meta.url).href)});
      const { mapperHandlers } = await import(${JSON.stringify(new URL("../src/mapper-server.ts", import.meta.url).href)});
      const { sqlModule } = await import(${JSON.stringify(new URL("../src/loader.ts", import.meta.url).href)});
      const handlers = mapperHandlers();
      const projectHandle = 'without-host-sqlite';
      await handlers.openProject({ projectHandle, configFileName: ${JSON.stringify(join(root, "tsconfig.json"))} });
      const transformed = await handlers.transform({ projectHandle, fileName: ${JSON.stringify(join(root, "get.sql"))}, content: ${JSON.stringify(SELECT)} });
      if (transformed.diagnostics.length || !transformed.text.includes('name: string')) throw new Error(JSON.stringify(transformed));
      const built = await sqlModule(${JSON.stringify(join(root, "get.sql"))}, ${JSON.stringify(SELECT)});
      if (!built.code.includes('select id')) throw new Error('No runtime query was generated');
      await handlers.closeProject({ projectHandle });
      const session = await Session.open(${JSON.stringify(root)}, {});
      try { console.log(JSON.stringify(await session.analyze(${JSON.stringify(SELECT)}))); }
      finally { for (const opened of Session.opened()) await opened.close(); }
    `], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const noAtlas = JSON.parse(child.stdout);
    assert.equal(noAtlas.ok, true, JSON.stringify(noAtlas));
    assert.deepEqual(noAtlas.analysis.columns.map(({ name, nullable }: { name: string; nullable: boolean }) => [name, nullable]), [["id", false], ["name", false]]);
    writeFileSync(join(root, "schema.hcl"), schema(true));
    const changed = await session.analyze(SELECT);
    assert.ok(changed.ok, JSON.stringify(changed));
    assert.equal(changed.source, "database");
    assert.equal(changed.analysis.columns[1]!.nullable, true);
    writeFileSync(join(root, "schema.hcl"), "table \"broken\" {");
    const invalid = await session.analyze(SELECT);
    assert.ok(!invalid.ok);
    assert.match(invalid.message, /Cannot evaluate HCL schema/);
    rmSync(join(root, "schema.hcl"));
    const missing = await session.analyze(SELECT);
    assert.ok(!missing.ok);
    assert.match(missing.message, /Cannot read HCL schema/);
    writeFileSync(join(root, "schema.hcl"), schema());
    const restored = await session.analyze(SELECT);
    assert.ok(restored.ok, JSON.stringify(restored));
    assert.equal(restored.analysis.columns[1]!.nullable, false);
    assert.ok(!readdirSync(root).some((name) => /\.(db|sqlite)(-|$)/.test(name)));
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mapper and runtime loader consume HCL directly without running migrations", async () => {
  const root = project();
  const handlers = mapperHandlers();
  const handle = `hcl-${root}`;
  const db = new DatabaseSync(":memory:");
  const identity = async () => {
    const projectHandle = `${handle}-identity`;
    try {
      return await handlers.openProject!({ projectHandle, configFileName: join(root, "tsconfig.json") }) as { configIdentity: string };
    } finally {
      await handlers.closeProject!({ projectHandle });
    }
  };
  try {
    const opened = await handlers.openProject!({ projectHandle: handle, configFileName: join(root, "tsconfig.json") }) as { watchedFiles: string[]; configIdentity: string };
    assert.ok(opened.watchedFiles.includes(join(root, "schema.hcl")));
    assert.equal((await identity()).configIdentity, opened.configIdentity);
    const declaration = await handlers.transform!({ projectHandle: handle, fileName: join(root, "get.sql"), content: SELECT }) as { text: string; diagnostics: unknown[] };
    assert.deepEqual(declaration.diagnostics, []);
    assert.match(declaration.text, /export type Params = \{ id: number \}/);
    assert.match(declaration.text, /export type Row = \{ id: number; name: string \}/);
    const built = await sqlModule(join(root, "get.sql"), SELECT);
    assert.ok(built.watched.includes(join(root, "schema.hcl")));
    const out = join(root, "get.mjs");
    writeFileSync(out, built.code.replace('from "reylo"', `from ${JSON.stringify(INDEX)}`));
    const query = (await import(pathToFileURL(out).href)).default;
    // The application owns its schema and migrations. The loader did not create this table.
    assert.equal(db.prepare("select count(*) as n from sqlite_schema where name = 'users'").get()!.n, 0);
    db.exec("create table users (id integer not null primary key, name text not null); insert into users values (1, 'Ada')");
    assert.deepEqual({ ...await query.run(db, { id: 1 }) }, { id: 1, name: "Ada" });
    writeFileSync(join(root, "schema.hcl"), schema(true));
    assert.notEqual((await identity()).configIdentity, opened.configIdentity);
    const updated = await handlers.transform!({ projectHandle: handle, fileName: join(root, "get.sql"), content: SELECT }) as { text: string; diagnostics: unknown[] };
    assert.deepEqual(updated.diagnostics, []);
    assert.match(updated.text, /name: string \| null/);
    writeFileSync(join(root, "schema.hcl"), "invalid HCL");
    await assert.rejects(sqlModule(join(root, "get.sql"), SELECT), /Cannot evaluate HCL schema/);
    assert.ok(!readdirSync(root).some((name) => /\.(db|sqlite)(-|$)/.test(name)));
  } finally {
    db.close();
    await handlers.closeProject!({ projectHandle: handle });
    for (const session of Session.opened()) if (session.root === root) await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
