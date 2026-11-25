// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub's native runner exercises SQLite casts against a real database.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Compare generated SQL, native rows, and runtime rejection messages.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Read the generated module that the native query fixture imports.
import { readFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the fixture's emitted module on the host filesystem.
import path from "node:path";
import { isRecord } from "#reylo-source/native-predicates.ts";
import { plain, requireFixtureValue } from "./helpers.ts";
import { importBuiltSqliteQuery, withProject } from "./sqlite-project-fixture.ts";
import type { SqliteProjectFixture } from "./sqlite-project-fixture.ts";

const SCHEMA = `create table users (id integer primary key, name text not null, born date, score real);
insert into users (name, born, score) values ('Ada', '1815-12-10', 1.5), ('Alan', '1912-06-23', 2.5), ('Grace', '1906-12-09', 3.5);`;

const built = async (root: string, name: string, sql: string): ReturnType<typeof importBuiltSqliteQuery> => {
  const query = await importBuiltSqliteQuery(root, name, sql);
  assert.equal(query["~standard"].query.text, `${query.sql} /*file='${name}.sql'*/`);
  return query;
};

const checkPageCast = async ({ database, root }: SqliteProjectFixture): Promise<void> => {
  const page = await built(root, "page", "select id from users order by id limit :n::int");
  assert.equal(page.sql, "select id from users order by id limit CAST(? AS INTEGER)");
  const rows = await page.run(database, { n: 2 });
  assert.ok(Array.isArray(rows) && rows.every((row) => isRecord(row)));
  assert.deepEqual(plain(rows), [{ id: 1 }, { id: 2 }]);
  // SQLite's CAST reads 'abc' as 0 and '1.9' as 1.
  const control = database.prepare("select cast('abc' as integer) as a, cast('1.9' as integer) as b").get();
  assert.deepEqual({ ...requireFixtureValue(control) }, { a: 0, b: 1 });
  await assert.rejects(page.run(database, { n: "abc" }), /Parameter "n" is int, an integer; got "abc"/u);
  await assert.rejects(page.run(database, { n: 1.9 }), /Parameter "n" is int, an integer; got 1\.9/u);
};

const checkDateCast = async ({ database, root }: SqliteProjectFixture): Promise<void> => {
  // SQLite's CAST to date reads only the number before the first dash, so Reylo casts to TEXT.
  const control = database.prepare("select cast('1900-01-01' as date) as d").get();
  assert.deepEqual({ ...requireFixtureValue(control) }, { d: 1900 });
  const born = await built(root, "born", "select name from users where born > :since::date order by born");
  assert.equal(born.sql, "select name from users where born > CAST(? AS TEXT) order by born");
  const rows = await born.run(database, { since: "1900-01-01" });
  assert.ok(Array.isArray(rows) && rows.every((row) => isRecord(row)));
  assert.deepEqual(plain(rows), [{ name: "Grace" }, { name: "Alan" }]);
};

const checkJsonCast = async ({ database, root }: SqliteProjectFixture): Promise<void> => {
  // SQLite treats json() as JSON inside a constructor and treats unwrapped text as a string.
  const doc = await built(root, "doc", "select json_extract(:doc::json, '$.a') as a, json_object('d', :inner::json, 's', :text) as d");
  assert.equal(doc.sql, "select json_extract(json(?), '$.a') as a, json_object('d', json(?), 's', ?) as d");
  const code = await readFile(path.join(root, "doc.mjs"), "utf8");
  assert.match(code, /"doc":\{"type":\{"kind":"json"/u);
  const result = await doc.run(database, { doc: { a: 5 }, inner: [1], text: "[1]" });
  assert.ok(isRecord(result));
  assert.deepEqual({ ...result }, { a: 5, d: { d: [1], s: "[1]" } });
};

const checkStringAndNumberCasts = async ({ database, root }: SqliteProjectFixture): Promise<void> => {
  const short = await built(root, "short", "select :s::varchar(3) as s, :x::real * 2 as x");
  await assert.rejects(short.run(database, { s: "abcd", x: 1 }), /Parameter "s" is varchar\(3\), at most 3 characters; got 4/u);
  await assert.rejects(short.run(database, { s: "abc", x: "2" }), /Parameter "x" is real, a finite number; got "2"/u);
  const value = await short.run(database, { s: "abc", x: 1.25 });
  assert.ok(isRecord(value));
  assert.deepEqual({ ...value }, { s: "abc", x: 2.5 });
  await assert.rejects(built(root, "flag", "select :b::boolean as b"), /SQLite has no boolean type/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a cast is SQLite's own, a date's to TEXT, JSON's through json(), and a value the cast would change is refused", async () => {
  await withProject(SCHEMA, async (fixture) => {
    await checkPageCast(fixture);
    await checkDateCast(fixture);
    await checkJsonCast(fixture);
    await checkStringAndNumberCasts(fixture);
  });
});
