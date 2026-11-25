// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub exercises the actual mapper and runtime loader.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Compare the runtime query and its inferred mapper declarations.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Edit the real HCL source and write the emitted JavaScript module.
import { writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve paths used by the content mapper and loader.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Import the emitted native module from its file URL.
import { pathToFileURL } from "node:url";
// oxlint-disable-next-line rules/no-node-imports -- Run the produced query against a caller-owned SQLite schema.
import { DatabaseSync } from "node:sqlite";
import { mapperHandlers } from "#reylo-source/mapper-server.ts";
import { isRecord, matchesString } from "#reylo-source/native-predicates.ts";
import { INDEX, importSqliteQueryFixture, requireFixtureValue } from "./helpers.ts";
import { compileHclQuery, hasDatabaseFiles, schema, schemaFile, SELECT, withHclProject } from "./hcl-project-fixture.ts";

interface OpenedProject { identity: string; watched: string[] }
interface Declaration { declaration: string; diagnostics: unknown[] }

const open = async (root: string, projectHandle: string): Promise<OpenedProject> => {
  const handle = requireFixtureValue(mapperHandlers().openProject);
  const result = await handle({ configFileName: path.join(root, "tsconfig.json"), projectHandle });
  assert.ok(isRecord(result) && matchesString(result.configIdentity));
  const watched: unknown = result.watchedFiles;
  assert.ok(Array.isArray(watched) && watched.every((entry) => matchesString(entry)));
  return { identity: result.configIdentity, watched };
};

const close = async (projectHandle: string): Promise<void> => {
  const handle = requireFixtureValue(mapperHandlers().closeProject);
  await handle({ projectHandle });
};

const identity = async (root: string, handle: string): Promise<string> => {
  const key = `${handle}-identity`;
  try {
    const opened = await open(root, key);
    return opened.identity;
  } finally {
    await close(key);
  }
};

const declaration = async (root: string, projectHandle: string): Promise<Declaration> => {
  const handle = requireFixtureValue(mapperHandlers().transform);
  const result = await handle({ content: SELECT, fileName: path.join(root, "get.sql"), projectHandle });
  assert.ok(isRecord(result) && matchesString(result.text) && Array.isArray(result.diagnostics));
  return { declaration: result.text, diagnostics: result.diagnostics };
};

const assertRuntime = async (root: string, database: DatabaseSync): Promise<void> => {
  const built = await compileHclQuery(root);
  assert.ok(built.watched.includes(schemaFile(root)));
  const output = path.join(root, "get.mjs");
  await writeFile(output, built.code.replace('from "@totto2727/reylo"', `from ${JSON.stringify(INDEX)}`));
  const query = await importSqliteQueryFixture(pathToFileURL(output).href, "maybeOne");
  const before = database.prepare("select count(*) as n from sqlite_schema where name = 'users'").get();
  assert.equal(requireFixtureValue(before).n, 0);
  database.exec("create table users (id integer not null primary key, name text not null); insert into users values (1, 'Ada')");
  assert.deepEqual({ ...await query.run(database, { id: 1 }) }, { id: 1, name: "Ada" });
};

const assertChange = async (root: string, handle: string, before: OpenedProject): Promise<void> => {
  await writeFile(schemaFile(root), schema(true));
  assert.notEqual(await identity(root, handle), before.identity);
  const updated = await declaration(root, handle);
  assert.deepEqual(updated.diagnostics, []);
  assert.match(updated.declaration, /name: string \| null/u);
  await writeFile(schemaFile(root), "invalid HCL");
  await assert.rejects(compileHclQuery(root), /Cannot evaluate HCL schema/u);
  assert.equal(await hasDatabaseFiles(root), false);
};

const assertInitialDeclaration = async (root: string, handle: string, opened: OpenedProject): Promise<void> => {
  assert.ok(opened.watched.includes(schemaFile(root)));
  assert.equal(await identity(root, handle), opened.identity);
  const initial = await declaration(root, handle);
  assert.deepEqual(initial.diagnostics, []);
  assert.match(initial.declaration, /export type Params = \{ id: number \}/u);
  assert.match(initial.declaration, /export type Row = \{ id: number; name: string \}/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the mapper and runtime loader consume HCL directly without running migrations", async () => {
  await withHclProject(async (root) => {
    const handle = `hcl-${root}`;
    const database = new DatabaseSync(":memory:");
    try {
      const opened = await open(root, handle);
      await assertInitialDeclaration(root, handle, opened);
      await assertRuntime(root, database);
      await assertChange(root, handle, opened);
    } finally {
      database.close();
      await close(handle);
    }
  });
});
