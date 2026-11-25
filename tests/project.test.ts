// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
import { engine } from "#reylo-source/engine.ts";
import { findProjectFile, resolveProject } from "#reylo-source/project.ts";
import { Session } from "#reylo-source/analyze.ts";
import { forEachFixtureInOrder, requireFixtureValue } from "./helpers.ts";
import { tree } from "./project-tree.ts";

type Reader = Awaited<ReturnType<typeof engine>>;
type Project = ReturnType<typeof resolveProject>;

// Any installed engine reads the shared project-file format.

const assertProjectOptions = async (currentEngine: Reader, local: Project): Promise<void> => {
  // A parameter nothing types is an error unless the project file says otherwise (since 2026-10-20).
  assert.equal(local.strictParams, true);
  const loose = await tree({ ".reylo.yaml": "direct_url: file:./x.db\nstrict_params: false\n", "package.json": "{}" });
  assert.equal(resolveProject(currentEngine, loose, {}).strictParams, false);
  assert.equal(resolveProject(currentEngine, await tree({ ".reylo.yaml": "direct_url: file:./x.db\n", "package.json": "{}" }), {}).strictParams, true);
  // The sqlcommenter comment is on unless the project file turns it off.
  assert.equal(local.sqlcommenter, true);
  assert.equal(resolveProject(currentEngine, await tree({ ".reylo.yaml": "direct_url: file:./x.db\nsqlcommenter: false\n", "package.json": "{}" }), {}).sqlcommenter, false);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("without a project file, DATABASE_URL comes from the environment, then .env.local, then .env", async () => {
  const currentEngine = await engine("sqlite");
  const root = await tree({ "app/.env": "DATABASE_URL=postgres://from-env-file/db\n", "app/.env.local": "DATABASE_URL=postgres://from-local/db\n", "app/package.json": "{}" });
  const dir = path.join(root, "app");
  assert.equal(findProjectFile(dir, {}), undefined);
  const local = resolveProject(currentEngine, dir, {});
  assert.deepEqual([local.url, local.urlSource, local.dialect, local.error], ["postgres://from-local/db", "DATABASE_URL in .env.local", "postgres", undefined]);
  const set = resolveProject(currentEngine, dir, { DATABASE_URL: "file:./x.db" });
  assert.deepEqual([set.url, set.urlSource, set.dialect], ["file:./x.db", "DATABASE_URL in the environment", "sqlite"]);
  await assertProjectOptions(currentEngine, local);

});

const assertProjectDiscovery = async (currentEngine: Reader, root: string): Promise<void> => {
  // A package of its own below does not see the file above it.
  const nested = await tree({ ".reylo.yaml": "direct_url: file:./a.db\n", "package.json": "{}", "packages/web/package.json": "{}" });
  assert.equal(findProjectFile(path.join(nested, "packages/web"), {}), undefined);
  // REYLO_CONFIG names the file instead.
  const other = await tree({ "elsewhere.yaml": "direct_url: file:./dev.db\n" });
  assert.equal(resolveProject(currentEngine, path.join(root, "src/db"), { REYLO_CONFIG: path.join(other, "elsewhere.yaml") }).dialect, "sqlite");
};

const assertDirectMetadata = (resolved: Project, root: string): void => {
  assert.equal(resolved.file, path.join(root, ".reylo.yaml"));
  assert.equal(resolved.root, root);
  // The type check takes the direct connection, and the dialect is its scheme's.
  assert.equal(resolved.url, "mysql://root:hunter2@127.0.0.1:3306/app");
  assert.equal(resolved.urlSource, '"direct_url" in ../../.reylo.yaml, DB_PASSWORD in ../../secrets.env');
  assert.equal(resolved.dialect, "mysql");
  assert.equal(resolved.strictParams, true);
  assert.equal(resolved.error, undefined);
  // A file that sets both has named Reylo's connection: nothing to say.
  assert.equal(resolved.notice, undefined);
  assert.ok(resolved.watched.includes(path.join(root, "secrets.env")));
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the project file sits beside package.json, and its direct_url, env files and strict_params apply", async () => {
  const currentEngine = await engine("sqlite");
  const root = await tree({
    ".reylo.yaml": `url: postgres://pooler/app\ndirect_url: mysql://root:\${DB_PASSWORD}@127.0.0.1:3306/app\nenv: [secrets.env]\nstrict_params: true\napi:\n  routes: api\n`,
    "package.json": "{}",
    "secrets.env": "DB_PASSWORD=hunter2\n",
    "src/db/tsconfig.json": "{}",
  });
  // The tsconfig sits below the package; the project file is the package's.
  const resolved = resolveProject(currentEngine, path.join(root, "src/db"), {});
  assertDirectMetadata(resolved, root);
  await assertProjectDiscovery(currentEngine, root);

});

const assertFileNameConflicts = async (currentEngine: Reader): Promise<void> => {
  const none = resolveProject(currentEngine, await tree({ "package.json": "{}" }), {});
  assert.equal(none.file, undefined);
  assert.equal(none.watched.filter((filename) => /\.reylo\.ya?ml$/u.test(filename)).length, 2);
  const both = await tree({ ".reylo.yaml": "direct_url: file:./a.db\n", ".reylo.yml": "direct_url: file:./b.db\n", "package.json": "{}" });
  assert.equal(resolveProject(currentEngine, both, {}).error, ".reylo.yaml and .reylo.yml are both project files; keep one.");
  // REYLO_CONFIG names the one file, whatever sits beside it.
  assert.equal(resolveProject(currentEngine, both, { REYLO_CONFIG: path.join(both, ".reylo.yml") }).error, undefined);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the project file may be named .reylo.yml, and both names beside one package.json are an error", async () => {
  const currentEngine = await engine("sqlite");
  const yml = await tree({ ".reylo.yml": "direct_url: file:./x.db\n", "package.json": "{}" });
  const resolved = resolveProject(currentEngine, yml, {});
  assert.deepEqual([resolved.file, resolved.dialect, resolved.error], [path.join(yml, ".reylo.yml"), "sqlite", undefined]);
  // Creating the other name would make the project an error, so the type check watches it.
  assert.ok(resolved.watched.includes(path.join(yml, ".reylo.yaml")));
  await assertFileNameConflicts(currentEngine);

});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a types section, removed on 2026-10-20, is refused where it stands, whatever it holds; package.json decides no type", async () => {
  const currentEngine = await engine("sqlite");
  await forEachFixtureInOrder(["types:\n  dates: temporal\n", "types: {}\n", "types:\n  datez: Date\n"], async (types) => {
    const manifest = JSON.stringify({ dependencies: { "@planetscale/database": "^1", mariadb: "^3" } });
    const root = await tree({ ".reylo.yaml": `direct_url: mysql://root@127.0.0.1:3306/app\n\n${types}`, "package.json": manifest });
    const resolved = resolveProject(currentEngine, root, {});
    assert.match(requireFixtureValue(resolved.error), /^\.reylo\.yaml:3:1: types: the types section was removed on 2026-10-20\. Reylo now gives every value one type on every driver, whatever the driver's settings: .* Delete the section\.$/u, types);
    assert.equal("repr" in resolved || "driver" in resolved, false);
    assert.ok(!resolved.watched.includes(path.join(root, "package.json")));
  });
  // A key that merely starts with `types` is the engine's to refuse, and a nested `types:` is another section's.
  const nested = await tree({ ".reylo.yaml": "direct_url: postgres://x/db\napi:\n  types: whatever\n", "package.json": "{}" });
  assert.equal(resolveProject(currentEngine, nested, {}).error, undefined);
});

const assertUnknownConnection = async (currentEngine: Reader): Promise<void> => {
  const unset = await tree({ ".reylo.yaml": `direct_url: \${NOPE}\n`, "package.json": "{}" });
  const resolved = resolveProject(currentEngine, unset, {});
  assert.equal(resolved.url, undefined);
  assert.match(requireFixtureValue(resolved.error), /^\.reylo\.yaml: "direct_url" names \$\{NOPE\}, which neither the environment nor/u);
  // A scheme reylo does not read names no dialect.
  const odd = await tree({ ".reylo.yaml": "direct_url: ./dev.db\n", "package.json": "{}" });
  assert.match(requireFixtureValue(resolveProject(currentEngine, odd, {}).error), /^Cannot tell the database from the URL \("direct_url" in \.reylo\.yaml\)/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a key the library does not know, and a variable nothing sets, are errors that say where", async () => {
  const currentEngine = await engine("sqlite");
  const typo = await tree({ ".reylo.yaml": "direct_url: postgres://x/db\n\nstirct: true\n", "package.json": "{}" });
  assert.match(requireFixtureValue(resolveProject(currentEngine, typo, {}).error), /^\.reylo\.yaml:3:1: unknown field `stirct`/u);
  // `strict` was renamed `strict_params` on 2026-10-20, with no alias: the old key is unknown, and its error names the new one.
  const renamed = await tree({ ".reylo.yaml": "direct_url: postgres://x/db\nstrict: true\n", "package.json": "{}" });
  assert.equal(resolveProject(currentEngine, renamed, {}).error, ".reylo.yaml:2:1: unknown field `strict`: the key is `strict_params` since 2026-10-20");
  await assertUnknownConnection(currentEngine);
});

// The type check never reads url, and a file that sets it alone is told to set direct_url.
const NOTICE = ".reylo.yaml: Reylo does not read url; set direct_url to the dev database Reylo reads your types from (it uses DATABASE_URL meanwhile)";

const assertDefaultNotice = async (currentEngine: Reader): Promise<void> => {
  // Without a project file, or without url in it, nothing is said either.
  assert.equal(resolveProject(currentEngine, await tree({ "package.json": "{}" }), {}).notice, undefined);
  assert.equal(resolveProject(currentEngine, await tree({ ".reylo.yaml": "strict_params: false\n", "package.json": "{}" }), {}).notice, undefined);
  assert.equal(resolveProject(currentEngine, await tree({ "package.json": "{}" }), {}).missingUrl, 'No database URL: set DATABASE_URL in the environment, .env.local or .env, or "direct_url" in .reylo.yaml.');
};

const assertUrlSelection = async (currentEngine: Reader): Promise<void> => {
  // Nothing in url is resolved or checked: an unset variable or an odd scheme there is the framework's to report.
  const unread = await tree({ ".reylo.yaml": `url: \${NOPE}/x\n`, "package.json": "{}" });
  const ignored = resolveProject(currentEngine, unread, { DATABASE_URL: "postgres://dev/app" });
  assert.deepEqual([ignored.url, ignored.error], ["postgres://dev/app", undefined]);
  // With no DATABASE_URL either, there is no connection, and the error says why url is not one.
  const none = resolveProject(currentEngine, await tree({ ".reylo.yaml": "url: postgres://prod-pooler/app\n", "package.json": "{}" }), {});
  assert.equal(none.url, undefined);
  assert.equal(none.error, undefined);
  assert.equal(none.missingUrl, "No database URL: .reylo.yaml sets url, which Reylo does not read; set direct_url there, or DATABASE_URL in the environment, .env.local or .env.");
  // Direct_url wins over DATABASE_URL, and with url beside it nothing is said.
  const both = resolveProject(currentEngine, await tree({ ".reylo.yaml": "url: postgres://prod-pooler/app\ndirect_url: postgres://dev/app\n", "package.json": "{}" }), { DATABASE_URL: "postgres://elsewhere/app" });
  assert.deepEqual([both.url, both.urlSource, both.notice], ["postgres://dev/app", '"direct_url" in .reylo.yaml', undefined]);
  await assertDefaultNotice(currentEngine);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("url is never the type check's connection: alone, it draws a notice and DATABASE_URL is used; direct_url wins; both draw nothing", async () => {
  const currentEngine = await engine("sqlite");
  // Url alone: DATABASE_URL, from the environment or an env file, and one notice that names direct_url.
  const alone = await tree({ ".env": "DATABASE_URL=postgres://dev/app\n", ".reylo.yaml": "url: postgres://prod-pooler/app\n", "package.json": "{}" });
  const fromFile = resolveProject(currentEngine, alone, {});
  assert.deepEqual([fromFile.url, fromFile.urlSource, fromFile.error, fromFile.notice], ["postgres://dev/app", "DATABASE_URL in .env", undefined, NOTICE]);
  const fromEnv = resolveProject(currentEngine, alone, { DATABASE_URL: "file:./dev.db" });
  assert.deepEqual([fromEnv.url, fromEnv.urlSource, fromEnv.dialect, fromEnv.notice], ["file:./dev.db", "DATABASE_URL in the environment", "sqlite", NOTICE]);
  await assertUrlSelection(currentEngine);

});

const entry = async (yaml: string, env: Record<string, string>): Promise<string[]> => {
  const session = await Session.open(await tree({ ".reylo.yaml": yaml, "package.json": "{}" }), env);
  await session.close();
  return path.basename(session.entryFile("select 1")).replace(/\.json$/u, "").split("-");
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test(".reylo/ names an entry by its statement, then its server: never by url or a password", async () => {
  const [statement, dev] = await entry("strict_params: true\n", { DATABASE_URL: "postgres://dev/app" });
  // Url alone names it like no url at all, and like a direct_url that names the same database;
  // The password is not part of it.
  assert.deepEqual(await entry("url: postgres://prod-pooler/app\n", { DATABASE_URL: "postgres://dev/app" }), [statement, dev]);
  assert.deepEqual(await entry("direct_url: postgres://:secret@dev/app\n", {}), [statement, dev]);
  // Another database of the dialect: the same statement, another server.
  const [same, other] = await entry("strict_params: true\n", { DATABASE_URL: "postgres://ci@127.0.0.1:5432/test" });
  assert.equal(same, statement);
  assert.notEqual(other, dev);
  // Without a URL, this SQLite-only install selects SQLite, not Postgres.
  const [withoutUrl] = await entry("strict_params: true\n", {});
  assert.notEqual(withoutUrl, statement);
  // Another dialect is another statement.
  const [otherDialect] = await entry("strict_params: true\n", { DATABASE_URL: "mysql://root@127.0.0.1:3306/app" });
  assert.notEqual(otherDialect, statement);
});
