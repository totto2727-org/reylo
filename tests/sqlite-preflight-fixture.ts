// oxlint-disable-next-line rules/no-node-imports -- Use a real per-project dependency installation layout for driver discovery.
import { access, mkdir, symlink, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve fixture package and SQLite paths on the current host.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Apply migrations to the database the preflight engine reads.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- Require successful analysis before checking the preflight diagnostics.
import assert from "node:assert/strict";
import { Session } from "#reylo-source/analyze.ts";
import type { Outcome } from "#reylo-source/analyze.ts";
import { matchesUndefined } from "#reylo-source/native-predicates.ts";
import { DRIVERS, forEachFixtureInOrder } from "./helpers.ts";
import { withProject } from "./sqlite-project-fixture.ts";

export const PRETTY = "select id, json_pretty(meta) as meta from notes where id = :id";
export const IIF = "select id, iif(id > 1, 'big') as size from notes";
export const DRIVER_ENV = { DATABASE_URL: "file:./app.db" };

const SCHEMA = "create table notes (id integer primary key, body text not null, meta text)";

const availability = async (packageName: string): Promise<string | undefined> => {
  try {
    await access(path.join(DRIVERS, packageName));
    return undefined;
  } catch {
    return packageName;
  }
};

const installations = await Promise.all(["better-sqlite3", "@libsql/client", "sqlite3"].map(async (name) => availability(name)));
const missing = installations.find((name) => !matchesUndefined(name));
export const skip = matchesUndefined(missing) ? false : `lab/drivers is not installed (no ${missing})`;
export const d1 = skip === false
  ? (await availability("wrangler")) === "wrangler" && "lab/drivers has no wrangler installed"
  : skip;

const link = async (root: string, driver: string): Promise<void> => {
  const to = path.join(root, "node_modules", driver);
  await mkdir(path.dirname(to), { recursive: true });
  await symlink(path.join(DRIVERS, driver), to);
};

export const install = async (root: string, drivers: string[]): Promise<void> => {
  const dependencies = Object.fromEntries(drivers.map((driver) => [driver, "*"]));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies }));
  await forEachFixtureInOrder(drivers, async (driver) => {await link(root, driver);});
};

export const withDrivers = async (drivers: string[], check: (root: string) => Promise<void>): Promise<void> => {
  await withProject(SCHEMA, async ({ database, root }) => {
    database.close();
    await install(root, drivers);
    await check(root);
  });
};

export const checkAnalysis = async (session: Session, sql: string): Promise<Extract<Outcome, { ok: true }>> => {
  const outcome = await session.analyze(sql);
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  return outcome;
};

export const analyze = async (root: string, sql: string): Promise<Extract<Outcome, { ok: true }>> => {
  const session = await Session.open(root, DRIVER_ENV);
  try {
    return await checkAnalysis(session, sql);
  } finally {
    await session.close();
  }
};

export const migrate = (root: string): void => {
  const database = new DatabaseSync(path.join(root, "app.db"));
  try {
    database.exec("alter table notes add column tag text; create table tags (name text primary key)");
  } finally {
    database.close();
  }
};

export const worker = async (root: string, d1Binding: boolean): Promise<void> => {
  const binding = { binding: "DB", database_id: "00000000-0000-0000-0000-000000000000", database_name: "reylo-test" };
  const config = {
    compatibility_date: "2026-10-01",
    ...(d1Binding && { d1_databases: [binding] }),
    main: "worker.js",
    name: "reylo-test",
  };
  await writeFile(path.join(root, "wrangler.jsonc"), JSON.stringify(config));
  await writeFile(path.join(root, "worker.js"), "export default { fetch() { return new Response(''); } };\n");
};
