// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to inspect or write files through the host filesystem.
import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to use the native HTTP server and its request lifecycle.
import { request } from "node:http";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
import { startPlay } from "#reylo-source/play.ts";
import { isRecord, matchesString } from "#reylo-source/native-predicates.ts";
import { forEachFixtureInOrder } from "./helpers.ts";

const EPHEMERAL_PORT = 0;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const LAST_SLASH = -1;
const ONE_DIAGNOSTIC = 1;
const FIRST_DIAGNOSTIC = 0;
const playDocument = "<!doctype html><title>the page</title>";

// `reylo play` (src/play.ts) serves the page it finds in the install; these tests give it one, so
// That they need no build of it.
const page = await mkdtemp(path.join(tmpdir(), "reylo-play-page-"));
await writeFile(path.join(page, "index.html"), playDocument);
// oxlint-disable-next-line node/no-process-env -- Give the real playground its page inside the disposable Node fixture.
process.env.REYLO_PLAY_PAGE = page;

const project = async function (files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "reylo-play-"));
  const root = await realpath(directory);
  await writeFile(path.join(root, "package.json"), "{}");
  await forEachFixtureInOrder(Object.entries(files), async ([name, text]) => {
    await mkdir(path.join(root, name, ".."), { recursive: true });
    await writeFile(path.join(root, name), text);
  });
  return root;
};

const get = async (url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> => {
  // oxlint-disable-next-line rules/no-fetch -- Exercise the native Node HTTP endpoint independently of the optional Effect peer.
  const res = await fetch(url, { headers });
  const body: unknown = res.headers.get("content-type")?.startsWith("application/json") === true ? await res.json() : await res.text();
  return { body, status: res.status };
};

const jsonObject = (body: unknown): Record<string, unknown> => {
  assert.ok(isRecord(body), "Expected a JSON object from the playground");
  return body;
};

const query = (url: string, sql: string): string => `${url}api/analyze?q=${encodeURIComponent(sql)}`;

const assertUser = async (url: string): Promise<void> => {
  const user = await get(query(url, "select id, name, email from users where id = :id"));
  assert.equal(user.status, HTTP_OK);
  assert.deepEqual({ ...jsonObject(user.body), ms: 0 }, { cardinality: "maybeOne", diagnostics: [], element: "{ id: number; name: string; email: string | null }", ms: 0, params: "{ id: number }", returns: "{ id: number; name: string; email: string | null } | null", sql: "select id, name, email from users where id = :id" });
};

const assertMissingColumn = async (url: string): Promise<void> => {
  // An error is placed as an editor counts: by line and column.
  const bad = await get(query(url, "select id,\n  nope\nfrom users"));
  const { diagnostics } = jsonObject(bad.body);
  assert.ok(Array.isArray(diagnostics));
  assert.equal(diagnostics.length, ONE_DIAGNOSTIC);
  const diagnostic = jsonObject(diagnostics[FIRST_DIAGNOSTIC]);
  assert.ok(matchesString(diagnostic.message));
  assert.match(diagnostic.message, /no such column: nope/u);
  assert.deepEqual({ column: diagnostic.column, line: diagnostic.line }, { column: 3, line: 2 });
};

const assertPostedTypes = async (url: string): Promise<void> => {
  // The same as JSON in a POST, with the types broken over lines past `width`.
  const body = JSON.stringify({ sql: "select id, name, email from users", width: 20 });
  // oxlint-disable-next-line rules/no-fetch -- Post JSON through the native Node HTTP endpoint without loading Effect.
  const res = await fetch(`${url}api/analyze`, { body, headers: { "content-type": "application/json" }, method: "POST" });
  const posted: unknown = await res.json();
  assert.equal(jsonObject(posted).returns, "{\n  id: number;\n  name: string;\n  email: string | null;\n}[]");
};

const assertSchema = async (url: string): Promise<void> => {
  // The schema card holds the database's own statements.
  const card = await get(`${url}api/page`);
  assert.equal(jsonObject(card.body).schema, "CREATE TABLE users (id integer primary key, name text not null, email text);");

  const schema = await get(`${url}api/schema`);
  assert.equal(jsonObject(schema.body).dialect, "sqlite");
  assert.deepEqual(jsonObject(schema.body).tables, [{ columns: [{ name: "id", nullable: true, type: "INTEGER" }, { name: "name", nullable: false, type: "TEXT" }, { name: "email", nullable: true, type: "TEXT" }], name: "users" }]);
};

const assertPage = async (url: string): Promise<void> => {
  // The page loads at a URL with its query or at a path outside the API.
  const withQuery = await get(`${url}?q=select%201`);
  assert.equal(withQuery.body, playDocument);
  const otherPath = await get(`${url}somewhere/else`);
  assert.equal(otherPath.body, playDocument);
  const selected = await get(query(url, "select 1"), {});
  assert.equal(selected.status, HTTP_OK);
  const missingQuery = await get(`${url}api/analyze`);
  assert.equal(missingQuery.status, HTTP_BAD_REQUEST);
};

const assertAnalysis = async (url: string): Promise<void> => {
  await assertUser(url);
  await assertMissingColumn(url);
  await assertPostedTypes(url);
  await assertSchema(url);
  await assertPage(url);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play analyzes each statement against the project's database, without running it or writing .reylo/", async () => {
  const root = await project({ ".reylo.yaml": 'direct_url: "file:./app.db"\n' });
  const db = new DatabaseSync(path.join(root, "app.db"));
  db.exec("create table users (id integer primary key, name text not null, email text)");
  db.close();
  const play = await startPlay({ cwd: root, env: {}, port: EPHEMERAL_PORT });
  try {
    assert.match(play.label, /^SQLite at .*app\.db \("direct_url" in \.reylo\.yaml\)$/u);
    await assertAnalysis(play.url);
    await assert.rejects(access(path.join(root, ".reylo")), { code: "ENOENT" });
  } finally {
    await play.close();
  }
});

const responseToOtherHost = async (url: string, schema: string): Promise<number | undefined> => {
  const { promise, resolve, reject } = Promise.withResolvers<number | undefined>();
  // Fetch sends its own Host header; use Node's native client to exercise the server's host check.
  request(schema, { headers: { host: `example.com:${new URL(url).port}` } }, (response) => {
    response.resume();
    resolve(response.statusCode);
  }).on("error", reject).end();
  return promise;
};

const assertOrigins = async (url: string): Promise<void> => {
  const schema = `${url}api/schema`;
  const tool = await get(schema);
  assert.equal(tool.status, HTTP_OK);
  const local = await get(schema, { origin: url.slice(0, LAST_SLASH) });
  assert.equal(local.status, HTTP_OK);
  const external = await get(schema, { origin: "https://example.com" });
  assert.equal(external.status, HTTP_FORBIDDEN);
  assert.equal(await responseToOtherHost(url, schema), HTTP_FORBIDDEN);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play answers this machine's own pages and tools, and refuses another site's page or a rebound name", async () => {
  const root = await project({ ".reylo.yaml": 'direct_url: "file:./app.db"\n' });
  new DatabaseSync(path.join(root, "app.db")).close();
  const play = await startPlay({ cwd: root, env: {}, port: EPHEMERAL_PORT });
  try {
    await assertOrigins(play.url);
  } finally {
    await play.close();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play says, as reylo generate does, that a project file's url alone is not read", async () => {
  const root = await project({ ".reylo.yaml": 'url: "file:./other.db"\n' });
  new DatabaseSync(path.join(root, "app.db")).close();
  const play = await startPlay({ cwd: root, env: { DATABASE_URL: "file:./app.db" }, port: EPHEMERAL_PORT });
  try {
    assert.match(play.label, /app\.db \(DATABASE_URL in the environment\)$/u);
    assert.match(play.notice ?? "", /Reylo does not read url; set direct_url/u);
  } finally {
    await play.close();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play refuses a project that names no database, and says where to try Reylo without one", async () => {
  const root = await project({});
  await assert.rejects(startPlay({ cwd: root, env: {}, port: EPHEMERAL_PORT }), /^Error: No database URL: .*reylo play reads the project's own database; to try Reylo without one, open https:\/\/reylo\.dev\/play\.$/u);
});
