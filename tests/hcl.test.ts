// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Change the real schema while the native session is running.
import { rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Supply real schema paths to the native analyzer and its child process.
import path from "node:path";
import { Session } from "#reylo-source/analyze.ts";
import { hclPath } from "#reylo-source/project.ts";
import { isRecord, matchesBoolean, matchesString } from "#reylo-source/native-predicates.ts";
import { requireFixtureValue, runChild } from "./helpers.ts";
import { catalogReader, hasDatabaseFiles, schema, schemaFile, SELECT, TMP, withHclProject } from "./hcl-project-fixture.ts";

const analyzedColumns = (output: string): [string, boolean][] => {
  const result: unknown = JSON.parse(output);
  assert.ok(isRecord(result) && result.ok === true, output);
  const { analysis } = result;
  assert.ok(isRecord(analysis) && Array.isArray(analysis.columns), output);
  return analysis.columns.map((column: unknown) => {
    assert.ok(isRecord(column) && matchesString(column.name) && matchesBoolean(column.nullable), output);
    return [column.name, column.nullable];
  });
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("HCL sources accept only one local .hcl file", () => {
  assert.equal(hclPath("hcl:./schema.hcl", TMP), schemaFile(TMP));
  assert.equal(hclPath("HCL:./schema.hcl", TMP), schemaFile(TMP));
  assert.equal(hclPath("file:./app.db", TMP), undefined);
  ["hcl:", "hcl://remote/schema.hcl", "hcl:./app.db", "hcl:./schema.hcl?mode=rw", "hcl:./schema.hcl#fragment", "hcl:./bad\0schema.hcl"].forEach((source) => {
    assert.throws(() => hclPath(source, TMP), /one local \.hcl file/u);
  });
});

const CATALOG_SQL = "select sql from sqlite_schema where sql is not null and type in ('table', 'view', 'index', 'trigger') order by rowid";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("HCL supplies only static schema rows and embedded function defaults to the engine", async () => {
  await withHclProject(async (root) => {
    const readCatalog = await catalogReader();
    const catalog = readCatalog(schemaFile(root));
    try {
      assert.deepEqual(await catalog.query(CATALOG_SQL, []), [['CREATE TABLE "users" ("id" integer NOT NULL, "name" text NOT NULL, PRIMARY KEY ("id"))']]);
      assert.deepEqual(await catalog.query("select name, narg, type from pragma_function_list", []), []);
      await assert.rejects(catalog.query(CATALOG_SQL, [1]), /do not accept parameters/u);
      await assert.rejects(catalog.query("create table unexpected (id text)", []), /Unsupported static HCL catalog request/u);
      const analyzed = await catalog.analyze("select upper(name), json_object('id', id) from users where id = :id");
      assert.deepEqual(analyzed.diagnostics, []);
    } finally {
      await catalog.close();
    }
  });
});

const assertCheckExpression = async (
  filename: string,
  readCatalog: Awaited<ReturnType<typeof catalogReader>>,
): Promise<void> => {
  // SQL expressions remain input to the existing embedded analyzer.
  const check = `  check { expr = ${JSON.stringify("name != ';' /* normal comment */")} }\n  primary_key {`;
  await writeFile(filename, schema().replace("  primary_key {", check));
  const catalog = readCatalog(filename);
  try {
    const result = await catalog.analyze(SELECT);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await catalog.close();
  }
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("invalid static declarations fail before the engine receives a catalog", async () => {
  await withHclProject(async (root) => {
    const readCatalog = await catalogReader();
    const filename = schemaFile(root);
    await writeFile(filename, schema().replace("type = text", "type = unknown_type"));
    assert.throws(() => readCatalog(filename), /Cannot evaluate HCL schema/u);
    await assertCheckExpression(filename, readCatalog);
    assert.equal(await hasDatabaseFiles(root), false);
  });
});

const assertNoHostSqlite = async (root: string): Promise<void> => {
  // oxlint-disable-next-line node/no-process-env -- Keep the native process environment except PATH for the no-host-SQLite proof.
  const env = { ...process.env, PATH: "" };
  const child = await runChild(process.execPath, ["--input-type=module", "-e", `
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
      await handlers.openProject({ projectHandle, configFileName: ${JSON.stringify(path.join(root, "tsconfig.json"))} });
      const transformed = await handlers.transform({ projectHandle, fileName: ${JSON.stringify(path.join(root, "get.sql"))}, content: ${JSON.stringify(SELECT)} });
      if (transformed.diagnostics.length || !transformed.text.includes('name: string')) throw new Error(JSON.stringify(transformed));
      const built = await sqlModule(${JSON.stringify(path.join(root, "get.sql"))}, ${JSON.stringify(SELECT)});
      if (!built.code.includes('select id')) throw new Error('No runtime query was generated');
      await handlers.closeProject({ projectHandle });
      const session = await Session.open(${JSON.stringify(root)}, {});
      try { console.log(JSON.stringify(await session.analyze(${JSON.stringify(SELECT)}))); }
      finally { for (const opened of Session.opened()) await opened.close(); }
    `], { cwd: process.cwd(), env });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(analyzedColumns(child.stdout), [["id", false], ["name", false]]);
};

const checkRestored = async (session: Session, root: string): Promise<void> => {
  await writeFile(schemaFile(root), schema());
  const restored = await session.analyze(SELECT);
  assert.ok(restored.ok, JSON.stringify(restored));
  assert.equal(requireFixtureValue(restored.analysis.columns[1]).nullable, false);
  assert.equal(await hasDatabaseFiles(root), false);
};

const checkBrokenSources = async (session: Session, filename: string): Promise<void> => {
  await writeFile(filename, 'table "broken" {');
  const invalid = await session.analyze(SELECT);
  assert.ok(!invalid.ok);
  assert.match(invalid.message, /Cannot evaluate HCL schema/u);
  await rm(filename);
  const missing = await session.analyze(SELECT);
  assert.ok(!missing.ok);
  assert.match(missing.message, /Cannot read HCL schema/u);
};

const checkInvalidation = async (session: Session, root: string): Promise<void> => {
  const filename = schemaFile(root);
  await writeFile(filename, schema(true));
  const changed = await session.analyze(SELECT);
  assert.ok(changed.ok, JSON.stringify(changed));
  assert.equal(changed.source, "database");
  assert.equal(requireFixtureValue(changed.analysis.columns[1]).nullable, true);
  await checkBrokenSources(session, filename);
  await checkRestored(session, root);
};

const checkInitialCatalog = async (session: Session, root: string): Promise<void> => {
  assert.equal(session.project.dialect, "sqlite");
  assert.ok(session.project.watched.includes(schemaFile(root)));
  const first = await session.analyze(SELECT);
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.source, "database");
  assert.equal(first.analysis.cardinality, "maybeOne");
  assert.deepEqual(first.analysis.columns.map(({ name, nullable }) => [name, nullable]), [["id", false], ["name", false]]);
  assert.deepEqual(first.analysis.params.map(({ name, nullable, type_name }) => [name, nullable, type_name]), [["id", false, "integer"]]);

};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Atlas HCL feeds the real SQLite engine and invalidates warm caches immediately", async () => {
  await withHclProject(async (root) => {
    const session = await Session.open(root, {});
    try {
      await checkInitialCatalog(session, root);
      const cached = await session.analyze(SELECT);
      assert.ok(cached.ok);
      assert.equal(cached.source, "cache");
      await assertNoHostSqlite(root);
      await checkInvalidation(session, root);
    } finally {
      await session.close();
    }
  });
});
