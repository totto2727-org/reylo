// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs these real driver cases through Node's test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Use native assertions to compare each driver's returned values and errors.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Compare the same query against Node's native SQLite driver.
import { DatabaseSync } from "node:sqlite";
import { Session } from "#reylo-source/analyze.ts";
import { renderType } from "#reylo-source/render.ts";
import { forEachFixtureInOrder, SQL_NULL } from "./helpers.ts";
import { built, closeSQLite3, loadDrivers, loadTurso, plain, representationOptions, withLabProject } from "./sqlite-driver-lab-fixture.ts";
import type { LabDrivers, SqliteQuery } from "./sqlite-driver-lab-fixture.ts";

const SCHEMA = `create table users (id integer primary key, name text not null, github_id bigint, score real, active boolean not null default 1, doc text);
    create table posts (id integer primary key, user_id integer not null references users (id), title text not null, body text) strict;
    insert into users values (1, 'ann', 9007199254740993, 1.5, 1, '[1]'), (2, 'bob', null, null, 0, null);
    insert into posts values (10, 1, 'hello', null), (11, 1, 'world', 'b')`;

const sql = {
  profile: `select json_object(
  'user', json_object('id', u.id, 'name', u.name),
  'posts', json((select json_group_array(json_object('id', p.id, 'title', p.title)) from posts p where p.user_id = u.id))
) as profile
from users u where u.id = :id::int`,
  // A BIGINT inside JSON is a JSON number, which JSON.parse rounds past 2^53, as on Postgres;
  // A truth value is 1 or 0 there, and a BOOLEAN column what it holds.
  values: `select json_object('big', github_id, 'score', score, 'flag', active, 'more', id > 1, 'pair', json_array(name, score), 'doc', doc) as o,
  doc, json_object('n', name) || '' as glued from users order by id`,
};

const ann = { profile: { posts: [{ id: 10, title: "hello" }, { id: 11, title: "world" }], user: { id: 1, name: "ann" } } };
const bob = { profile: { posts: [], user: { id: 2, name: "bob" } } };
const rows = [
  { doc: "[1]", glued: '{"n":"ann"}', o: { big: 9_007_199_254_740_992, doc: "[1]", flag: 1, more: 0, pair: ["ann", 1.5], score: 1.5 } },
  { doc: SQL_NULL, glued: '{"n":"bob"}', o: { big: SQL_NULL, doc: SQL_NULL, flag: 0, more: 1, pair: ["bob", SQL_NULL], score: SQL_NULL } },
];

const checkRenderedTypes = async (root: string): Promise<void> => {
  const session = await Session.for(root);
  try {
    const types: Record<string, string> = {};
    await forEachFixtureInOrder(Object.entries(sql), async ([name, text]) => {
      const outcome = await session.analyze(text);
      assert.ok(outcome.ok, `${name}: ${outcome.ok ? "" : outcome.message}`);
      types[name] = outcome.analysis.columns.map((column) => `${column.name}: ${renderType(column.type, false, "sqlite")}${column.nullable ? " | null" : ""}`).join("; ");
    });
    assert.deepEqual(types, {
      profile: "profile: { user: { id: number; name: string }; posts: { id: number; title: string }[] }",
      values: "o: { big: number | null; score: number | null; flag: number | string; more: number; pair: [string, number | null]; doc: string | null }; doc: string | null; glued: string",
    });
  } finally {
    await session.close();
  }
};

type RunQuery = (query: SqliteQuery, params?: Record<string, unknown>) => unknown;
type Check = (label: string, run: RunQuery) => Promise<void>;

const verifyValues = (profile: SqliteQuery, values: SqliteQuery): Check => async (label, run) => {
  assert.deepEqual(plain(await run(profile, { id: 1 })), ann, `${label}: the profile`);
  assert.deepEqual(plain(await run(profile, { id: 2 })), bob, `${label}: a user with no posts`);
  assert.deepEqual(plain(await run(values)), rows, `${label}: the values`);
};

const checkNativeDrivers = async (file: string, { BetterSQLite, createClient }: LabDrivers, check: Check): Promise<void> => {
  await forEachFixtureInOrder([false, true], async (safe) => {
    const db = new BetterSQLite(file);
    db.defaultSafeIntegers(safe);
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    await check(`better-sqlite3 with defaultSafeIntegers(${safe})`, (query, parameters) => query.runSync(db, parameters));
    assert.equal(typeof db.prepare("select json_object('a', 1) as o").get().o, "string", "the control: the app's own statement");
    db.close();
  });
  await forEachFixtureInOrder([false, true], async (readBigInts) => {
    const node = new DatabaseSync(file, { readBigInts });
    await check(`node:sqlite with readBigInts ${readBigInts}`, async (query, parameters) => query.run(node, parameters));
    node.close();
  });
  await forEachFixtureInOrder(["number", "bigint", "string"], async (intMode) => {
    const client = createClient({ intMode, url: `file:${file}` });
    await check(`libSQL with intMode ${intMode}`, async (query, parameters) => query.run(client, parameters));
    client.close();
  });
};

const checkTurso = async (file: string, check: Check): Promise<void> => {
  const { connect, TursoCompat } = await loadTurso();
  const tdb = await connect(file);
  await check("Turso's engine", async (query, parameters) => query.run(tdb, parameters));
  await tdb.close();
  const compat = new TursoCompat(file);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  await check("Turso's compat Database", (query, parameters) => query.runSync(compat, parameters));
  compat.close();
};

const checkWrappers = async (file: string, { open, SQLite3 }: LabDrivers, check: Check): Promise<void> => {
  const s3 = new SQLite3(file);
  await check("sqlite3", async (query, parameters) => query.run(s3, parameters));
  await closeSQLite3(s3);
  const wrapper = await open({ driver: SQLite3, filename: file });
  await check("sqlite", async (query, parameters) => query.run(wrapper, parameters));
  await wrapper.close();
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: JSON a statement builds is the object its type says on every driver, and a text column that holds JSON stays a string", representationOptions, async () => {
  const drivers = loadDrivers();
  await withLabProject(SCHEMA, async ({ file, root }) => {
    await checkRenderedTypes(root);
    const profile = await built(root, "profile", sql.profile);
    const values = await built(root, "values", sql.values);
    const check = verifyValues(profile, values);
    await checkNativeDrivers(file, drivers, check);
    await checkTurso(file, check);
    await checkWrappers(file, drivers, check);
  });
});
