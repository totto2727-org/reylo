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
import { join } from "node:path";
import { startPlay } from "#reylo-source/play.ts";
import { isRecord, matchesString } from "#reylo-source/native-predicates.ts";
import { forEachFixtureInOrder } from "./helpers.ts";

const EPHEMERAL_PORT = 0;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;

// `reylo play` (src/play.ts) serves the page it finds in the install; these tests give it one, so
// That they need no build of it.
const page = await mkdtemp(join(tmpdir(), "reylo-play-page-"));
await writeFile(join(page, "index.html"), "<!doctype html><title>the page</title>");
process.env.REYLO_PLAY_PAGE = page;

const project = async function (files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reylo-play-"));
  const root = await realpath(directory);
  await writeFile(join(root, "package.json"), "{}");
  await forEachFixtureInOrder(Object.entries(files), async ([name, text]) => {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), text);
  });
  return root;
};

const get = async (url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(url, { headers });
  const body: unknown = res.headers.get("content-type")?.startsWith("application/json") === true ? await res.json() : await res.text();
  return { body, status: res.status };
};

const jsonObject = (body: unknown): Record<string, unknown> => {
  assert.ok(isRecord(body), "Expected a JSON object from the playground");
  return body;
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play analyzes each statement against the project's database, without running it or writing .reylo/", async () => {
  const root = await project({ ".reylo.yaml": 'direct_url: "file:./app.db"\n' });
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table users (id integer primary key, name text not null, email text)");
  db.close();
  const play = await startPlay({ cwd: root, port: EPHEMERAL_PORT, env: {} });
  try {
    assert.match(play.label, /^SQLite at .*app\.db \("direct_url" in \.reylo\.yaml\)$/);
    const q = (sql: string): string => `${play.url}api/analyze?q=${encodeURIComponent(sql)}`;

    const user = await get(q("select id, name, email from users where id = :id"));
    assert.equal(user.status, HTTP_OK);
    assert.deepEqual({ ...jsonObject(user.body), ms: 0 }, { cardinality: "maybeOne", diagnostics: [], element: "{ id: number; name: string; email: string | null }", ms: 0, params: "{ id: number }", returns: "{ id: number; name: string; email: string | null } | null", sql: "select id, name, email from users where id = :id" });

    // An error is placed as an editor counts: by line and column.
    const bad = await get(q("select id,\n  nope\nfrom users"));
    const { diagnostics } = jsonObject(bad.body);
    assert.ok(Array.isArray(diagnostics));
    assert.equal(diagnostics.length, 1);
    const diagnostic = jsonObject(diagnostics[0]);
    assert.ok(matchesString(diagnostic.message));
    assert.match(diagnostic.message, /no such column: nope/u);
    assert.deepEqual({ column: diagnostic.column, line: diagnostic.line }, { column: 3, line: 2 });

    // The same as JSON in a POST, with the types broken over lines past `width`.
    const res = await fetch(`${play.url}api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "select id, name, email from users", width: 20 }) });
    const posted: unknown = await res.json();
    assert.equal(jsonObject(posted).returns, "{\n  id: number;\n  name: string;\n  email: string | null;\n}[]");

    // The schema card holds the database's own statements.
    const card = await get(`${play.url}api/page`);
    assert.equal(jsonObject(card.body).schema, "CREATE TABLE users (id integer primary key, name text not null, email text);");

    const schema = await get(`${play.url}api/schema`);
    assert.equal(jsonObject(schema.body).dialect, "sqlite");
    assert.deepEqual(jsonObject(schema.body).tables, [{ columns: [{ name: "id", nullable: true, type: "INTEGER" }, { name: "name", nullable: false, type: "TEXT" }, { name: "email", nullable: true, type: "TEXT" }], name: "users" }]);

    // The page at any path but the API's, which reads its query from the address.
    assert.equal((await get(`${play.url}?q=select%201`)).body, "<!doctype html><title>the page</title>");
    assert.equal((await get(`${play.url}somewhere/else`)).body, "<!doctype html><title>the page</title>");
    assert.equal((await get(q("select 1"), {})).status, HTTP_OK);
    assert.equal((await get(`${play.url}api/analyze`)).status, HTTP_BAD_REQUEST);
    await assert.rejects(access(join(root, ".reylo")), { code: "ENOENT" });
  } finally {
    await play.close();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play answers this machine's own pages and tools, and refuses another site's page or a rebound name", async () => {
  const root = await project({ ".reylo.yaml": 'direct_url: "file:./app.db"\n' });
  new DatabaseSync(join(root, "app.db")).close();
  const play = await startPlay({ cwd: root, port: EPHEMERAL_PORT, env: {} });
  try {
    const schema = `${play.url}api/schema`;
    assert.equal((await get(schema)).status, HTTP_OK);
    assert.equal((await get(schema, { origin: play.url.slice(0, -1) })).status, HTTP_OK);
    assert.equal((await get(schema, { origin: "https://example.com" })).status, HTTP_FORBIDDEN);
    // Fetch() sends its own Host header; a name rebound to 127.0.0.1 sends the name.
    const rebound = await new Promise<number | undefined>((done, fail) => {
      request(schema, { headers: { host: `example.com:${new URL(play.url).port}` } }, (res) => {
        res.resume();
        done(res.statusCode);
      }).on("error", fail).end();
    });
    assert.equal(rebound, HTTP_FORBIDDEN);
  } finally {
    await play.close();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play says, as reylo generate does, that a project file's url alone is not read", async () => {
  const root = await project({ ".reylo.yaml": 'url: "file:./other.db"\n' });
  new DatabaseSync(join(root, "app.db")).close();
  const play = await startPlay({ cwd: root, port: EPHEMERAL_PORT, env: { DATABASE_URL: "file:./app.db" } });
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
  await assert.rejects(startPlay({ cwd: root, port: EPHEMERAL_PORT, env: {} }), /^Error: No database URL: .*reylo play reads the project's own database; to try Reylo without one, open https:\/\/reylo\.dev\/play\.$/);
});
