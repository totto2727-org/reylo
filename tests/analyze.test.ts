// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Read, copy, and age the native cache entries as real filesystem files.
import { access, cp, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Create the actual database and apply schema changes that invalidate the cache.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The native engine and tests use the current host's paths.
import path from "node:path";
import { Session } from "#reylo-source/analyze.ts";
import type { Outcome } from "#reylo-source/analyze.ts";
import { isRecord, matchesNumber } from "#reylo-source/native-predicates.ts";
import { forEachFixtureInOrder, requireFixtureValue, ROOT } from "./helpers.ts";
import { nativeTestDirectory } from "./native-engine-fixture.ts";

const USERS = "create table users (id integer primary key, name text not null)";
const DATABASE = { DATABASE_URL: "file:./app.db" };
const ALTERNATE = { DATABASE_URL: "file:./test.db" };
const MISSING_DATABASE = { DATABASE_URL: "file:./elsewhere.db" };

const seed = (filename: string, sql: string): void => {
  const database = new DatabaseSync(filename);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
};

const project = async (): Promise<string> => {
  const root = await nativeTestDirectory("reylo-analyze-");
  await writeFile(path.join(root, "package.json"), "{}");
  seed(path.join(root, "app.db"), USERS);
  return root;
};

interface Request { force?: boolean; sql: string }

// Each session stands for a process of its own: the type check, a build, or reylo generate.
const analyze = async (root: string, env: Record<string, string>, { force, sql }: Request): Promise<Outcome> => {
  const session = await Session.open(root, env);
  try {
    return await session.analyze(sql, { force: force ?? false });
  } finally {
    await session.close();
  }
};

const successful = (outcome: Outcome): Extract<Outcome, { ok: true }> => {
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome;
};

const SELECT = "select id, name from users where id = :id";
const SELECT_ALL = "select * from users";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a statement is analyzed against the database once, and read from .reylo/ by every process after", async () => {
  const root = await project();
  const first = successful(await analyze(root, DATABASE, { sql: SELECT }));
  assert.equal(first.source, "database");
  assert.equal(first.analysis.cardinality, "maybeOne");
  assert.ok(first.entry.startsWith(path.join(root, ".reylo", "queries")));
  await access(first.entry);
  // The directory keeps itself out of git.
  const ignore = await readFile(path.join(root, ".reylo", ".gitignore"), "utf8");
  assert.match(ignore, /^\*$/mu);
  const second = successful(await analyze(root, DATABASE, { sql: SELECT }));
  assert.deepEqual([second.source, second.entry, second.analysis], ["cache", first.entry, first.analysis]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a change to the schema makes the entry stale, and the statement is analyzed again", async () => {
  const root = await project();
  const before = successful(await analyze(root, DATABASE, { sql: SELECT_ALL }));
  assert.deepEqual(before.analysis.columns.map((column) => column.name), ["id", "name"]);
  seed(path.join(root, "app.db"), "alter table users add column email text");
  const after = successful(await analyze(root, DATABASE, { sql: SELECT_ALL }));
  assert.equal(after.source, "database");
  assert.deepEqual(after.analysis.columns.map((column) => column.name), ["id", "name", "email"]);
  assert.equal(after.entry, before.entry);
});

const checkMissingCacheEntry = async (root: string): Promise<void> => {
  const missing = await analyze(root, DATABASE, { sql: "select name from users" });
  assert.ok(!missing.ok);
  assert.equal(missing.code, 5);
  assert.match(missing.message, /^Cannot open the database .*app\.db .*\.reylo has no analysis of this statement, so run reylo generate where the database can be reached\.$/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("without the database, .reylo/ answers as it is, and a statement it lacks is an error that names reylo generate", async () => {
  const root = await project();
  successful(await analyze(root, DATABASE, { sql: SELECT }));
  await rename(path.join(root, "app.db"), path.join(root, "gone.db"));
  const cached = successful(await analyze(root, DATABASE, { sql: SELECT }));
  assert.equal(cached.source, "cache");
  await checkMissingCacheEntry(root);
  // --force asks the database even for a statement .reylo/ holds.
  const forced = await analyze(root, DATABASE, { force: true, sql: SELECT });
  assert.ok(!forced.ok);
});

interface CacheEntry { at: number; filename: string }

const entries = async (root: string): Promise<CacheEntry[]> => {
  const directory = path.join(root, ".reylo", "queries");
  const stored: CacheEntry[] = [];
  await forEachFixtureInOrder(await readdir(directory), async (name) => {
    const filename = path.join(directory, name);
    const content: unknown = JSON.parse(await readFile(filename, "utf8"));
    assert.ok(isRecord(content) && matchesNumber(content.at));
    stored.push({ at: content.at, filename });
  });
  return stored.toSorted((left, right) => left.at - right.at);
};

const checkRecordedOrder = async (root: string): Promise<void> => {
  await forEachFixtureInOrder(["app.db", "test.db"], async (filename) => {
    await rename(path.join(root, filename), path.join(root, `${filename}.gone`));
  });
  const [first, last] = await entries(root);
  const older = requireFixtureValue(first).filename;
  const newer = requireFixtureValue(last).filename;
  // Reverse the filesystem timestamps to prove the stored timestamp decides the fallback.
  await utimes(newer, 946_684_800, 946_684_800);
  await utimes(older, 1_000_000_000, 1_000_000_000);
  const offline = successful(await analyze(root, MISSING_DATABASE, { sql: SELECT_ALL }));
  assert.deepEqual([offline.source, offline.entry, offline.analysis.columns.length], ["cache", newer, 3]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("two databases the project uses in turn keep an entry each, so neither analyzes the other's statements again", async () => {
  const root = await project();
  seed(path.join(root, "test.db"), "create table users (id integer primary key, name text not null, email text)");
  const sources: string[] = [];
  await forEachFixtureInOrder([DATABASE, ALTERNATE, DATABASE, ALTERNATE], async (environment) => {
    const outcome = successful(await analyze(root, environment, { sql: SELECT_ALL }));
    sources.push(`${outcome.source} ${outcome.analysis.columns.length}`);
  });
  assert.deepEqual(sources, ["database 2", "database 3", "cache 2", "cache 3"]);
  await checkRecordedOrder(root);
});


const checkCopiedCache = async (root: string): Promise<void> => {
  // A copy of the project at another path, as a container build has it, without its database.
  const copy = await nativeTestDirectory("reylo-analyze-copy-");
  await cp(root, copy, { recursive: true, verbatimSymlinks: true });
  await rm(path.join(copy, "app.db"));
  const moved = successful(await analyze(copy, DATABASE, { sql: SELECT }));
  assert.equal(moved.source, "cache");
  assert.ok(moved.entry.startsWith(path.join(copy, ".reylo")));
};

const checkOfflineWithoutUrl = async (root: string, entry: string): Promise<void> => {
  // No URL: the entries are used as they are, and a statement they lack needs a URL.
  const bare = successful(await analyze(root, {}, { sql: SELECT }));
  assert.deepEqual([bare.source, bare.entry], ["cache", entry]);
  const lacking = await analyze(root, {}, { sql: "select name from users" });
  assert.ok(!lacking.ok);
  assert.deepEqual([lacking.code, lacking.message], [4, 'No database URL: set DATABASE_URL in the environment, .env.local or .env, or "direct_url" in .reylo.yaml.']);
  const forced = await analyze(root, {}, { force: true, sql: SELECT });
  assert.ok(!forced.ok);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a build that cannot reach the database reads .reylo/ with another URL, with none, and in a copy of the project elsewhere", async () => {
  const root = await project();
  // The project installs its database's engine, which names the dialect where no URL does.
  await mkdir(path.join(root, "node_modules", "@totto2727"), { recursive: true });
  await symlink(path.join(ROOT, "packages", "sqlite"), path.join(root, "node_modules", "@totto2727", "reylo-sqlite"));
  const typed = successful(await analyze(root, DATABASE, { sql: SELECT }));
  assert.equal(typed.source, "database");
  await checkOfflineWithoutUrl(root, typed.entry);
  // Another URL, to a database the build cannot open, reads the same entry.
  const other = successful(await analyze(root, MISSING_DATABASE, { sql: SELECT }));
  assert.deepEqual([other.source, other.entry], ["cache", typed.entry]);
  await checkCopiedCache(root);
});
