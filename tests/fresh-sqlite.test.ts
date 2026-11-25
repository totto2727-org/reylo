// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite using Node's integration test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Match native SQLite's rows and failures exactly.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- These fixtures change the database through its actual SQLite connection.
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "#reylo-source/native-predicates.ts";
import { plain, requireFixtureValue } from "./helpers.ts";
import { importBuiltSqliteQuery as built, withProject } from "./sqlite-project-fixture.ts";

const resultRows = (result: unknown): Record<string, unknown>[] => {
  assert.ok(Array.isArray(result) && result.every((row) => isRecord(row)));
  return result;
};

const checkColumnRenames = async function (root: string, database: DatabaseSync): Promise<void> {
  const read = await built(root, "read3", "select id, email from users order by id");
  database.exec("alter table users rename column email to mail");
  await assert.rejects(read.run(database), /The database changed after read3\.sql was built: users\.email was TEXT not null and no longer exists\. Build it again/u);
  const readSynchronously = await built(root, "read4", "select id, name from users order by id");
  database.exec("alter table users rename column name to full_name");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Reylo checks the renamed column on its native synchronous SQLite path.
  assert.throws(() => readSynchronously.runSync(database), /users\.name was TEXT and no longer exists/u);
};

const USERS_SCHEMA = `create table users (id integer primary key, email text not null, name text);
insert into users (email, name) values ('a@x', 'Ada');`;

const checkAddedColumns = async function (root: string, database: DatabaseSync): Promise<void> {
  const read = await built(root, "read", "select id, email from users order by id");
  const rows = resultRows(await read.run(database));
  assert.deepEqual(plain(rows), [{ email: "a@x", id: 1 }]);
  database.exec("alter table users add column bio text");
  const readAfterBio = await built(root, "read2", "select id, email from users order by id");
  database.exec("alter table users add column age integer");
  assert.equal(resultRows(await readAfterBio.run(database)).length, 1);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a query whose columns changed fails, naming them; one whose table gained a column it does not name runs", async () => {
  await withProject(USERS_SCHEMA, async ({ database, root }) => {
    await checkAddedColumns(root, database);
    await checkColumnRenames(root, database);
    const insert = await built(root, "insert", "insert into users (mail) values (:mail)");
    database.exec("alter table users add column tenant integer not null default 0");
    await insert.run(database, { mail: "b@x" });
  });
});

const ACCOUNTS_SCHEMA = "create table accounts (id integer primary key, name text not null, role text not null default 'member')";
const INSERT_ACCOUNTS = "insert into accounts :a::rows(name text not null, role? text not null) returning role";

const changeAccountDefault = (database: DatabaseSync): void => {
  database.exec(`create table accounts_new (id integer primary key, name text not null, role text not null default 'guest');
    insert into accounts_new select * from accounts; drop table accounts; alter table accounts_new rename to accounts`);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a default a structured insert copied, changed after the build, fails the call naming the table and the column", async () => {
  await withProject(ACCOUNTS_SCHEMA, async ({ database, root }) => {
    const insert = await built(root, "insert_accounts", INSERT_ACCOUNTS);
    const rows = resultRows(await insert.run(database, { a: [{ name: "Ada" }, { name: "Grace", role: "admin" }] }));
    assert.deepEqual(plain(rows), [{ role: "member" }, { role: "admin" }]);
    const stale = await built(root, "insert_accounts2", INSERT_ACCOUNTS);
    changeAccountDefault(database);
    await assert.rejects(stale.run(database, { a: [{ name: "Linus" }] }), /The database changed after insert_accounts2\.sql was built: accounts\.role had the default 'member', which the insert writes for a row that leaves its key out, and now has the default 'guest'\. Build it again/u);
    const count = requireFixtureValue(database.prepare("select count(*) as n from accounts").get());
    assert.equal(count.n, 2);
    const read = await built(root, "read", "select name, role from accounts order by id");
    assert.equal(resultRows(await read.run(database)).length, 2);
  });
});
