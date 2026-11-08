import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sqlModule } from "../src/loader.ts";
import { DRIVERS, INDEX, closeSessions, plain } from "./helpers.ts";

// SQLite's parameter casts are compiled to its own syntax, and values are checked before binding.

function project(driver?: string): string {
  const root = mkdtempSync(join(tmpdir(), "reylo-casts-"));
  writeFileSync(join(root, "package.json"), "{}");
  if (driver) {
    mkdirSync(join(root, "node_modules"));
    symlinkSync(join(DRIVERS, driver), join(root, "node_modules", driver));
  }
  return root;
}

/** The module a build step writes for `sql`, imported, and its compiled statement (the query's `sql`), which Reylo sends with its file's comment after it. */
async function built(root: string, url: string, name: string, sql: string) {
  const file = join(root, `${name}.sql`);
  writeFileSync(file, sql);
  writeFileSync(join(root, ".env"), `DATABASE_URL=${url}\n`);
  const { code } = await sqlModule(file, sql);
  const out = join(root, `${name}.mjs`);
  writeFileSync(out, code.replace(`from "@totto2727/reylo"`, `from ${JSON.stringify(INDEX)}`));
  const module = await import(pathToFileURL(out).href);
  const text = module.default.sql as string;
  assert.equal(module.default["~standard"].query.text, `${text} /*file='${name}.sql'*/`);
  return { query: module.default, text, code };
}

test("SQLite: a cast is SQLite's own, a date's to TEXT, JSON's through json(), and a value the cast would change is refused", async () => {
  const root = project();
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table users (id integer primary key, name text not null, born date, score real)");
  db.exec("insert into users (name, born, score) values ('Ada', '1815-12-10', 1.5), ('Alan', '1912-06-23', 2.5), ('Grace', '1906-12-09', 3.5)");
  const url = "file:./app.db";
  try {
    const page = await built(root, url, "page", "select id from users order by id limit :n::int");
    assert.equal(page.text, "select id from users order by id limit CAST(? AS INTEGER)");
    assert.deepEqual(plain(await page.query.run(db, { n: 2 })), [{ id: 1 }, { id: 2 }]);
    // SQLite's CAST reads 'abc' as 0 and '1.9' as 1.
    assert.deepEqual({ ...(db.prepare("select cast('abc' as integer) as a, cast('1.9' as integer) as b").get() as object) }, { a: 0, b: 1 });
    await assert.rejects(page.query.run(db, { n: "abc" }), /Parameter "n" is int, an integer; got "abc"/);
    await assert.rejects(page.query.run(db, { n: 1.9 }), /Parameter "n" is int, an integer; got 1\.9/);
    // Its CAST to `date` reads a date as the number before its first dash, so a date is cast to TEXT.
    assert.deepEqual({ ...(db.prepare("select cast('1900-01-01' as date) as d").get() as object) }, { d: 1900 });
    const born = await built(root, url, "born", "select name from users where born > :since::date order by born");
    assert.equal(born.text, "select name from users where born > CAST(? AS TEXT) order by born");
    assert.deepEqual(plain(await born.query.run(db, { since: "1900-01-01" })), [{ name: "Grace" }, { name: "Alan" }]);
    // json() makes the text a JSON value inside SQLite's JSON functions, where text alone is a
    // string; the object json_object builds comes back parsed.
    const doc = await built(root, url, "doc", "select json_extract(:doc::json, '$.a') as a, json_object('d', :inner::json, 's', :text) as d");
    assert.equal(doc.text, "select json_extract(json(?), '$.a') as a, json_object('d', json(?), 's', ?) as d");
    assert.match(doc.code, /"doc":\{"type":\{"kind":"json"/);
    assert.deepEqual({ ...(await doc.query.run(db, { doc: { a: 5 }, inner: [1], text: "[1]" })) }, { a: 5, d: { d: [1], s: "[1]" } });
    const short = await built(root, url, "short", "select :s::varchar(3) as s, :x::real * 2 as x");
    await assert.rejects(short.query.run(db, { s: "abcd", x: 1 }), /Parameter "s" is varchar\(3\), at most 3 characters; got 4/);
    await assert.rejects(short.query.run(db, { s: "abc", x: "2" }), /Parameter "x" is real, a finite number; got "2"/);
    assert.deepEqual({ ...(await short.query.run(db, { s: "abc", x: 1.25 })) }, { s: "abc", x: 2.5 });
    await assert.rejects(built(root, url, "flag", "select :b::boolean as b"), /SQLite has no boolean type/);
  } finally {
    db.close();
    await closeSessions();
  }
});
