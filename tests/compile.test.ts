import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { checks, defineQuery, type Query } from "../src/index.ts";
import { ParameterError } from "../src/values.ts";

const insert = defineQuery<{ id: number; name: string; note?: string | null }, never, "none", "sqlite">({
  dialect: "sqlite",
  sql: "insert into users (id, name, note) values (:id, :name, :note)",
  params: ["id", "name", "note"],
  text: "insert into users (id, name, note) values (?, ?, ?)",
  order: ["id", "name", "note"],
  inputs: {
    id: { type: { kind: "scalar", name: "int" }, nullable: false },
    name: { type: { kind: "scalar", name: "text" }, nullable: false },
    note: { type: { kind: "scalar", name: "text" }, nullable: true },
  },
  cardinality: "none",
  source: "queries/insert_user.sql",
});

test("sqlite: compile returns positional SQL and values in the compiled binding order", () => {
  const query = defineQuery<{ id: number; name: string }, never, "none", "sqlite">({
    dialect: "sqlite",
    sql: "select :id, :name, :id",
    params: ["name", "id"],
    text: "select ?, ?, ?",
    order: ["id", "name", "id"],
  });
  assert.deepEqual(query.compile({ name: "Ada", id: 7 }), {
    sql: "select ?, ?, ?",
    parameters: [7, "Ada", 7],
  });
});

test("sqlite: compile binds an omitted nullable input as SQL NULL", () => {
  assert.deepEqual(insert.compile({ id: 1, name: "Ada" }), {
    sql: "insert into users (id, name, note) values (?, ?, ?)",
    parameters: [1, "Ada", null],
  });
});

test("sqlite: compile binds an explicit nullable input as SQL NULL", () => {
  assert.deepEqual(insert.compile({ id: 1, name: "Ada", note: null }).parameters, [1, "Ada", null]);
});

test("sqlite: compile refuses a missing required input and keeps the query source", () => {
  assert.throws(() => {
    // @ts-expect-error A required query input cannot be omitted.
    insert.compile({ name: "Ada" });
  }, { name: "TypeError", message: 'queries/insert_user.sql: Parameter "id" is missing, and the statement takes no null for it: pass a value.' });
});

test("sqlite: compile refuses an explicit null for a required input", () => {
  assert.throws(() => {
    // @ts-expect-error A required number cannot be SQL NULL.
    insert.compile({ id: null, name: "Ada" });
  }, ParameterError);
});

test("sqlite: compile refuses positional arrays instead of named input objects", () => {
  assert.throws(() => {
    // @ts-expect-error Query inputs are named objects, not positional arrays.
    insert.compile([1, "Ada"]);
  }, ParameterError);
});

test("sqlite: compile uses the existing cast checks for a wrong scalar input", () => {
  const query = defineQuery<{ id: number }, never, "none", "sqlite">({
    dialect: "sqlite", sql: "select :id", params: ["id"], checks,
    inputs: { id: { type: { kind: "scalar", name: "int" }, cast: "int", nullable: false } },
  });
  assert.throws(() => {
    // @ts-expect-error The cast checks also protect untyped callers at runtime.
    query.compile({ id: "not an integer" });
  }, ParameterError);
});

test("sqlite: compile preserves boolean and JSON encoding", () => {
  const query = defineQuery<{ enabled: boolean; payload: { value: number } }, never, "none", "sqlite">({
    dialect: "sqlite", sql: "select :enabled, :payload", params: ["enabled", "payload"],
    inputs: {
      enabled: { type: { kind: "scalar", name: "bool" } },
      payload: { type: { kind: "json" } },
    },
  });
  assert.deepEqual(query.compile({ enabled: true, payload: { value: 7 } }), {
    sql: "select ?, ?", parameters: [1, '{"value":7}'],
  });
});

test("sqlite: compile accepts no argument when the query has no inputs", () => {
  const query = defineQuery<{}, never, "none", "sqlite">({ dialect: "sqlite", sql: "select 1", params: [] });
  assert.deepEqual(query.compile(), { sql: "select 1", parameters: [] });
});

test("sqlite: compile preserves the configured SQL source comment", () => {
  const query = defineQuery<{}, never, "none", "sqlite">({
    dialect: "sqlite", sql: "select 1;", params: [], source: "queries/one.sql", sqlcommenter: true,
  });
  assert.deepEqual(query.compile(), { sql: "select 1 /*file='queries%2Fone.sql'*/;", parameters: [] });
});

test("compile refuses a non-SQLite query instead of promising driver-neutral bindings", () => {
  const query = defineQuery<{}, never, "none", "postgres">({ dialect: "postgres", sql: "select 1", params: [] });
  assert.throws(() => {
    // @ts-expect-error Only SQLite has a driver-independent compile contract here.
    query.compile();
  }, /supports SQLite queries only/);
});

// This function is checked by the normal TypeScript task, but never executed.
function compileInputTypes(query: Query<{ id: number }, never, "none", "sqlite">) {
  query.compile({ id: 1 });
  // @ts-expect-error Required input objects cannot be left out.
  query.compile();
  // @ts-expect-error SQL input types stay checked at the batch boundary.
  query.compile({ id: "1" });
}

test("sqlite: compiled writes execute in a native transaction and commit together", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("create table users (id integer primary key, name text not null, note text)");
  const statements = [insert.compile({ id: 1, name: "Ada" }), insert.compile({ id: 2, name: "Lin" })];
  assert.deepEqual(db.prepare("select * from users").all(), []);
  db.exec("begin");
  statements.forEach(({ sql, parameters }) => {
    const values = parameters.map((value) => {
      assert.ok(value === null || typeof value === "string" || typeof value === "number");
      return value;
    });
    db.prepare(sql).run(...values);
  });
  db.exec("commit");
  assert.deepEqual(db.prepare("select id, name, note from users order by id").all().map((row) => ({ ...row })), [
    { id: 1, name: "Ada", note: null }, { id: 2, name: "Lin", note: null },
  ]);
});

test("sqlite: a later compiled constraint failure can roll back every write", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("create table users (id integer primary key, name text not null, note text)");
  const statements = [insert.compile({ id: 1, name: "Ada" }), insert.compile({ id: 1, name: "Lin" })];
  db.exec("begin");
  assert.throws(() => statements.forEach(({ sql, parameters }) => {
    const values = parameters.map((value) => {
      assert.ok(value === null || typeof value === "string" || typeof value === "number");
      return value;
    });
    db.prepare(sql).run(...values);
  }), /UNIQUE constraint failed/);
  db.exec("rollback");
  assert.deepEqual(db.prepare("select * from users").all(), []);
});
