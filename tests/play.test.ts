// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { startPlay } from "../src/play.ts";

// `reylo play` (src/play.ts) serves the page it finds in the install; these tests give it one, so
// That they need no build of it.
const page = mkdtempSync(join(tmpdir(), "reylo-play-page-"));
writeFileSync(join(page, "index.html"), "<!doctype html><title>the page</title>");
process.env.REYLO_PLAY_PAGE = page;

const project = function (files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reylo-play-")));
  writeFileSync(join(root, "package.json"), "{}");
  Object.entries(files).forEach(([name, text]) => {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  });
  return root;
};

// The body is `any`: each test asserts on the JSON it expects.
const get = async (url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(url, { headers });
  return { status: res.status, body: res.headers.get("content-type")?.startsWith("application/json") ? await res.json() : await res.text() };
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play analyzes each statement against the project's database, without running it or writing .reylo/", async () => {
  const root = project({ ".reylo.yaml": 'direct_url: "file:./app.db"\n' });
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table users (id integer primary key, name text not null, email text)");
  db.close();
  const play = await startPlay({ cwd: root, port: 0, env: {} });
  try {
    assert.match(play.label, /^SQLite at .*app\.db \("direct_url" in \.reylo\.yaml\)$/);
    const q = (sql: string): string => `${play.url}api/analyze?q=${encodeURIComponent(sql)}`;

    const user = await get(q("select id, name, email from users where id = :id"));
    assert.equal(user.status, 200);
    assert.deepEqual({ ...user.body, ms: 0 }, { cardinality: "maybeOne", diagnostics: [], element: "{ id: number; name: string; email: string | null }", ms: 0, params: "{ id: number }", returns: "{ id: number; name: string; email: string | null } | null", sql: "select id, name, email from users where id = :id" });

    // An error is placed as an editor counts: by line and column.
    const bad = await get(q("select id,\n  nope\nfrom users"));
    assert.equal(bad.body.diagnostics.length, 1);
    assert.match(bad.body.diagnostics[0].message, /no such column: nope/u);
    assert.deepEqual({ line: bad.body.diagnostics[0].line, column: bad.body.diagnostics[0].column }, { column: 3, line: 2 });

    // The same as JSON in a POST, with the types broken over lines past `width`.
    const res = await fetch(`${play.url}api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "select id, name, email from users", width: 20 }) });
    assert.equal(((await res.json()) as any).returns, "{\n  id: number;\n  name: string;\n  email: string | null;\n}[]");

    // The schema card holds the database's own statements.
    const card = await get(`${play.url}api/page`);
    assert.equal(card.body.schema, "CREATE TABLE users (id integer primary key, name text not null, email text);");

    const schema = await get(`${play.url}api/schema`);
    assert.equal(schema.body.dialect, "sqlite");
    assert.deepEqual(schema.body.tables, [{ columns: [{ name: "id", nullable: true, type: "INTEGER" }, { name: "name", nullable: false, type: "TEXT" }, { name: "email", nullable: true, type: "TEXT" }], name: "users" }]);

    // The page at any path but the API's, which reads its query from the address.
    assert.equal((await get(`${play.url}?q=select%201`)).body, "<!doctype html><title>the page</title>");
    assert.equal((await get(`${play.url}somewhere/else`)).body, "<!doctype html><title>the page</title>");
    assert.equal((await get(q("select 1"), {})).status, 200);
    assert.equal((await get(`${play.url}api/analyze`)).status, 400);
    assert.equal(existsSync(join(root, ".reylo")), false);
  } finally {
    await play.close();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play answers this machine's own pages and tools, and refuses another site's page or a rebound name", async () => {
  const root = project({ ".reylo.yaml": 'direct_url: "file:./app.db"\n' });
  new DatabaseSync(join(root, "app.db")).close();
  const play = await startPlay({ cwd: root, port: 0, env: {} });
  try {
    const schema = `${play.url}api/schema`;
    assert.equal((await get(schema)).status, 200);
    assert.equal((await get(schema, { origin: play.url.slice(0, -1) })).status, 200);
    assert.equal((await get(schema, { origin: "https://example.com" })).status, 403);
    // Fetch() sends its own Host header; a name rebound to 127.0.0.1 sends the name.
    const rebound = await new Promise<number>((done, fail) => request(schema, { headers: { host: `example.com:${new URL(play.url).port}` } }, (res) => (res.resume(), done(res.statusCode!))).on("error", fail).end());
    assert.equal(rebound, 403);
  } finally {
    await play.close();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play says, as reylo generate does, that a project file's url alone is not read", async () => {
  const root = project({ ".reylo.yaml": 'url: "file:./other.db"\n' });
  new DatabaseSync(join(root, "app.db")).close();
  const play = await startPlay({ cwd: root, port: 0, env: { DATABASE_URL: "file:./app.db" } });
  try {
    assert.match(play.label, /app\.db \(DATABASE_URL in the environment\)$/u);
    assert.match(play.notice ?? "", /Reylo does not read url; set direct_url/u);
  } finally {
    await play.close();
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reylo play refuses a project that names no database, and says where to try Reylo without one", async () => {
  const root = project({});
  await assert.rejects(startPlay({ cwd: root, port: 0, env: {} }), /^Error: No database URL: .*reylo play reads the project's own database; to try Reylo without one, open https:\/\/reylo\.dev\/play\.$/);
});
