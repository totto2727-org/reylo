// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Build real temporary projects for the CLI subprocess.
import { mkdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to convert local module URLs with the host platform's path rules.
import { pathToFileURL } from "node:url";
import { matchesUndefined } from "#reylo-source/native-predicates.ts";
import { forEachFixtureInOrder, requireFixtureValue, runChild } from "./helpers.ts";
import { nativeTestDirectory } from "./native-engine-fixture.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const REGISTER = path.join(import.meta.dirname, "..", "src", "register.ts");
// oxlint-disable-next-line node/no-process-env -- Native subprocesses inherit the host executable search path while each test chooses its own database configuration.
const pathEnv = { PATH: process.env.PATH };
const sqliteEnv = { ...pathEnv, DATABASE_URL: "file:./app.db" };

const USER_SCHEMA = "create table users (id integer primary key, name text not null)";

const seed = (root: string, schema: string): void => {
  const db = new DatabaseSync(path.join(root, "app.db"));
  try {
    db.exec(schema);
  } finally {
    db.close();
  }
};

const project = async (prefix: string, schema?: string): Promise<string> => {
  // The CLI reports the physical working directory, including /private/var on macOS.
  const temporary = await nativeTestDirectory(prefix);
  const root = await realpath(temporary);
  await writeFile(path.join(root, "package.json"), "{}");
  if (!matchesUndefined(schema)) {seed(root, schema);}
  return root;
};

const writeFixtures = async (root: string, files: Record<string, string>): Promise<void> => {
  await forEachFixtureInOrder(Object.entries(files), async ([name, text]) => {
    const filename = path.join(root, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, text);
  });
};

const reylo = async (cwd: string, ...args: string[]): Promise<{ status: number | null; out: string; err: string }> => {
  const result = await runChild(process.execPath, [CLI, ...args], { cwd, env: sqliteEnv });
  // The time varies from run to run; everything else is the readout.
  return { err: result.stderr, out: result.stdout.replace(/\(\d+\.\d s\)/u, "(_ s)"), status: result.status };
};

const QUERY_FILES = {
  // CLI reports server-only queries, errors, single statements, and skipped migrations.
  ".gitignore": "generated/\n",
  ".next/y.sql": "select 1",
  "app/.server/queries/names.sql": "select name from users",
  "generated/z.sql": "select 1",
  "migrations/0001.sql": "create table posts (id integer primary key);\ncreate index posts_id on posts (id);",
  "migrations/0002.sql": "alter table posts add column title text;\nalter table posts add column body text;",
  "node_modules/dep/x.sql": "select 1",
  "src/queries/bad.sql": "select id\nfrom nope",
  "src/queries/count.sql": "select count(*) as n from users",
  "src/queries/index.sql": "create index users_name on users (name)",
  "src/queries/stale.sql": "create index users_email on users (email)",
  "src/queries/typo.sql": "selec id from users",
  "src/queries/user.sql": "select id, name from users where id = :id",
};

const checkGenerateOutput = async (root: string): Promise<void> => {
  const first = await reylo(root, "generate");
  assert.equal(first.status, 1, first.err);
  // Starting the native engine must not print diagnostics during a successful command.
  assert.equal(first.err, "");
  assert.equal(first.out, [
    `sqlite at ${path.join(root, "app.db")} (DATABASE_URL in the environment)`,
    `  app/.server/queries/names.sql  ✓`,
    `  src/queries/bad.sql            ✗`,
    `  src/queries/count.sql          ✓`,
    `  src/queries/index.sql          ✓`,
    `  src/queries/stale.sql          ✗`,
    `  src/queries/typo.sql           ✗`,
    `  src/queries/user.sql           ✓`,
    ``,
    // SQLite names no place for this error, so no line of the statement is shown.
    `src/queries/bad.sql:1:1: no such table: nope`,
    ``,
    // A command the database refuses fails, and its message says how to leave a migration out.
    `src/queries/stale.sql:1:36: no such column: email, so if it is a migration or a schema file, leave it out of the type check with "exclude" in tsconfig.json, as in "exclude": ["db/**"].`,
    `  1 | create index users_email on users (email)`,
    `    |                                    ^^^^^`,
    ``,
    // A misspelt keyword is an error, not a statement that is not a query.
    `src/queries/typo.sql:1:1: near "selec": syntax error`,
    `  1 | selec id from users`,
    `    | ^^^^^`,
    ``,
    `Skipped 2 files that are not one query (a migration?): migrations/0001.sql, migrations/0002.sql`,
    ``,
    `✗ 3 of 7 queries failed (_ s)`,
    ``,
  ].join("\n"));

  // A run that finds no query fails, so that a CI job does not carry an empty .reylo/ to a build.
  const none = await reylo(root, "generate", "migrations");
  assert.equal(none.status, 1, none.err);
  assert.match(none.out, /^Skipped 2 files that are not one query \(a migration\?\): .*\n\nNo query under migrations: name the directory that holds them, or set cli\.include in \.reylo\.yaml\.\n$/mu);
};

const checkConfiguredScope = async (root: string): Promise<void> => {
  // .reylo.yaml narrows the files; a file named on the command line is analyzed as named.
  await writeFile(path.join(root, ".reylo.yaml"), `cli:\n  include: ["src/**/*.sql"]\n  exclude: ["**/bad.sql", "**/stale.sql", "**/typo.sql"]\n`);
  const configured = await reylo(root, "generate");
  assert.equal(configured.status, 0, configured.err);
  assert.match(configured.out, /^ {2}src\/queries\/count\.sql {2}✓\n {2}src\/queries\/index\.sql {2}✓\n {2}src\/queries\/user\.sql {3}✓\n\n✓ 3 queries typed \(_ s\)\n$/mu);
  const refused = await reylo(root, "generate", "src/queries/bad.sql");
  assert.equal(refused.status, 1);
};

const checkOfflineAndInvalidArguments = async (root: string): Promise<void> => {
  // Without the database the cache still answers, and --force cannot.
  await rename(path.join(root, "app.db"), path.join(root, "gone.db"));
  const offline = await reylo(root, "generate", "src/queries/user.sql");
  assert.equal(offline.status, 0, offline.err);
  assert.match(offline.out, /^Cannot open the database .*app\.db \(DATABASE_URL in the environment\): .*; the files are read from \.reylo\/ as they are\.$/mu);
  assert.match(offline.out, /^ {2}src\/queries\/user\.sql {2}✓$/mu);
  const forced = await reylo(root, "generate", "--force", "src/queries/user.sql");
  assert.equal(forced.status, 1);
  assert.match(forced.out, /^src\/queries\/user\.sql: --force needs the database, which cannot be reached$/mu);

  await forEachFixtureInOrder([["generate", "--watch"], ["generate", "package.json"], ["frobnicate"]], async (args) => {
    const rejected = await reylo(root, ...args);
    assert.equal(rejected.status, 2);
  });
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo generate analyzes every .sql file of the project, and prints each file with a mark and every error in full", async () => {
  const root = await project("reylo-cli-", USER_SCHEMA);
  await writeFixtures(root, QUERY_FILES);
  const initialized = await runChild("git", ["init", "-q"], { cwd: root });
  assert.equal(initialized.status, 0);
  await checkGenerateOutput(root);
  await checkConfiguredScope(root);
  await checkOfflineAndInvalidArguments(root);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo generate's hint for a run that finds no query names a .reylo.yml project's own file", async () => {
  const root = await project("reylo-cli-yml-");
  await writeFile(path.join(root, ".reylo.yml"), "strict_params: true\n");
  // No .sql file opens a project here, so the hint reads the project file of the directory searched.
  const none = await reylo(root, "generate");
  assert.equal(none.status, 1, none.err);
  assert.equal(none.out, "No query under .: name the directory that holds them, or set cli.include in .reylo.yml.\n");
});

const successfulFiles = (output: string): string[] =>
  [...output.matchAll(/^ {2}(?<filename>\S+)\s+✓$/gmu)].map((match) => requireFixtureValue(match.groups?.filename));

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo generate's globs: a directory named like a .sql file is searched, an include may name a directory, and one starting with ! excludes", async () => {
  const root = await project("reylo-cli-globs-", USER_SCHEMA);
  await writeFixtures(root, {
    "src/legacy/old.sql": "select 1 as one",
    "src/queries/names.sql": "select name from users",
    "src/queries/x.sql/ids.sql": "select id from users",
  });

  const all = await reylo(root, "generate");
  assert.equal(all.status, 0, all.err);
  assert.deepEqual(successfulFiles(all.out), ["src/legacy/old.sql", "src/queries/names.sql", "src/queries/x.sql/ids.sql"]);

  await writeFile(path.join(root, ".reylo.yaml"), `cli:\n  include: ["src", "!src/legacy/**"]\n`);
  const configured = await reylo(root, "generate");
  assert.equal(configured.status, 0, configured.err);
  assert.deepEqual(successfulFiles(configured.out), ["src/queries/names.sql", "src/queries/x.sql/ids.sql"]);
});

const checkUrlFallback = async (root: string): Promise<void> => {
  // Without DATABASE_URL there is no connection, and the one error says why url is not one.
  const none = await runChild(process.execPath, [CLI, "generate", "--force"], { cwd: root, env: pathEnv });
  assert.equal(none.status, 1, none.stderr);
  assert.match(none.stdout, /^No database URL: \.reylo\.yaml sets url, which Reylo does not read; set direct_url there, or DATABASE_URL in the environment, \.env\.local or \.env\.$/mu);
  assert.doesNotMatch(none.stdout, /it uses DATABASE_URL meanwhile/u);
  // Direct_url beside url names Reylo's connection: the run reads direct_url and says nothing more.
  await writeFile(path.join(root, ".reylo.yaml"), "url: postgres://prod-pooler/app\ndirect_url: file:./app.db\n");
  const both = await reylo(root, "generate");
  assert.equal(both.status, 0, both.err);
  assert.match(both.out, /^sqlite at .*app\.db \("direct_url" in \.reylo\.yaml\)\n {2}a\.sql {2}✓\n/u);
  assert.doesNotMatch(both.out, /does not read url/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo generate says once that the type check does not read url, and names the connection it used", async () => {
  const root = await project("reylo-cli-url-", USER_SCHEMA);
  await writeFixtures(root, { "a.sql": "select id from users", "b.sql": "select name from users" });
  // Reylo does not read url: the run reads DATABASE_URL, and says so once, not per file.
  await writeFile(path.join(root, ".reylo.yaml"), "url: postgres://prod-pooler/app\n");
  const alone = await reylo(root, "generate");
  assert.equal(alone.status, 0, alone.err);
  assert.equal(alone.out, [
    `sqlite at ${path.join(root, "app.db")} (DATABASE_URL in the environment)`,
    `.reylo.yaml: Reylo does not read url; set direct_url to the dev database Reylo reads your types from (it uses DATABASE_URL meanwhile)`,
    `  a.sql  ✓`,
    `  b.sql  ✓`,
    ``,
    `✓ 2 queries typed (_ s)`,
    ``,
  ].join("\n"));
  await checkUrlFallback(root);
});

const installRuntime = async (root: string): Promise<void> => {
  // The module a `.sql` file becomes imports reylo, as a lab reaches it: through a link to this repository.
  await mkdir(path.join(root, "node_modules", "@totto2727"), { recursive: true });
  await symlink(path.join(import.meta.dirname, ".."), path.join(root, "node_modules", "@totto2727/reylo"));
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a program run under the @totto2727/reylo/register preload prints nothing on stderr", async () => {
  const root = await project("reylo-register-", `${USER_SCHEMA}; insert into users (name) values ('ada')`);
  await writeFile(path.join(root, "package.json"), `{ "type": "module" }`);
  await installRuntime(root);
  await writeFile(path.join(root, "user.sql"), "select id, name from users where id = :id");
  await writeFile(path.join(root, "main.ts"), `import { DatabaseSync } from "node:sqlite";\nimport user from "./user.sql";\nconsole.log(JSON.stringify(await user.run(new DatabaseSync("app.db"), { id: 1 })));\n`);
  // The engine loads in the preload's worker thread, which reports its warnings through the main thread's stderr.
  const result = await runChild(process.execPath, ["--import", pathToFileURL(REGISTER).href, "main.ts"], { cwd: root, env: sqliteEnv });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `{"id":1,"name":"ada"}\n`);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/u);
  assert.equal(result.stderr, "");
});
