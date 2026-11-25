// oxlint-disable-next-line rules/no-node-imports -- Create the disposable native SQLite project and its SQL inputs.
import { mkdtemp, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- A real build and analysis run against the local SQLite fixture.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- Place the fixture in the host's temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- Resolve fixture paths with native filesystem conventions.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Import the generated module from its native file URL.
import { pathToFileURL } from "node:url";
// oxlint-disable-next-line rules/no-node-imports -- Require the real engine analysis to complete successfully.
import assert from "node:assert/strict";
import { Session } from "#reylo-source/analyze.ts";
import type { Analysis } from "#reylo-source/engine.ts";
import { sqlModule } from "#reylo-source/loader.ts";
import { closeSessions, INDEX, importSqliteQueryFixture } from "./helpers.ts";
import type { SqliteQueryFixture } from "./helpers.ts";

const URL = "file:./app.db";

export interface StructuredProject {
  database: DatabaseSync;
  root: string;
}

const project = async function (schemaSource = ""): Promise<StructuredProject> {
  const root = await mkdtemp(path.join(tmpdir(), "reylo-structured-"));
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, ".env"), `DATABASE_URL=${URL}\n`);
  const database = new DatabaseSync(path.join(root, "app.db"));
  try {
    database.exec(schemaSource);
    return { database, root };
  } catch (error) {
    database.close();
    throw error;
  }
};

export const withProject = async function (
  schema: string,
  check: (fixture: StructuredProject) => Promise<void>,
): Promise<void> {
  const fixture = await project(schema);
  try {
    await check(fixture);
  } finally {
    if (fixture.database.isOpen) {fixture.database.close();}
    await closeSessions();
  }
};

export const querySource = async function (root: string, name: string, sql: string): Promise<string> {
  const file = path.join(root, `${name}.sql`);
  await writeFile(file, sql);
  return file;
};

export const built = async function (root: string, name: string, sql: string): Promise<SqliteQueryFixture<"many">> {
  const file = await querySource(root, name, sql);
  const { code } = await sqlModule(file, sql);
  const out = path.join(root, `${name}.mjs`);
  await writeFile(out, code.replace(`from "@totto2727/reylo"`, `from ${JSON.stringify(INDEX)}`));
  return importSqliteQueryFixture(pathToFileURL(out).href, "many");
};

export const analysis = async function (root: string, sql: string): Promise<Analysis> {
  const session = await Session.open(root, { DATABASE_URL: URL });
  try {
    const outcome = await session.analyze(sql, { force: true });
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
    return outcome.analysis;
  } finally {
    await session.close();
  }
};
