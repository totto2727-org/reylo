import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { checks, defineQuery, type StandardQueryV1 } from "../src/index.ts";
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
  columns: [],
  cardinality: "none",
  source: "queries/insert_user.sql",
});

// A generic consumer checks inferred inputs, then passes them unchanged to Standard Query.
function encode<Q extends StandardQueryV1<unknown, unknown, "sqlite">>(query: Q, ...args: StandardQueryV1.InferArgs<Q>) {
  return query["~standard"].query.encode(args[0]);
}

test("sqlite: Standard Query uses positional SQL and the compiled binding order", () => {
  const query = defineQuery<{ id: number; name: string }, never, "none", "sqlite">({
    dialect: "sqlite", sql: "select :id, :name, :id", params: ["name", "id"],
    text: "select ?, ?, ?", order: ["id", "name", "id"],
  });
  assert.equal(query["~standard"].query.text, "select ?, ?, ?");
  assert.deepEqual(encode(query, { name: "Ada", id: 7 }), [7, "Ada", 7]);
  assert.equal("compile" in query, false);
});

test("sqlite: Standard Query binds omitted and explicit nullable inputs as SQL NULL", () => {
  assert.deepEqual(encode(insert, { id: 1, name: "Ada" }), [1, "Ada", null]);
  assert.deepEqual(encode(insert, { id: 1, name: "Ada", note: null }), [1, "Ada", null]);
});

test("sqlite: Standard Query refuses a missing required input", () => {
  assert.throws(() => {
    // @ts-expect-error A required query input cannot be omitted.
    encode(insert, { name: "Ada" });
  }, { name: "TypeError", message: 'Parameter "id" is missing, and the statement takes no null for it: pass a value.' });
});

test("sqlite: Standard Query refuses null required inputs and positional arrays", () => {
  assert.throws(() => {
    // @ts-expect-error A required number cannot be SQL NULL.
    encode(insert, { id: null, name: "Ada" });
  }, ParameterError);
  assert.throws(() => {
    // @ts-expect-error Query inputs are named objects, not positional arrays.
    encode(insert, [1, "Ada"]);
  }, ParameterError);
  assert.throws(() => insert["~standard"].query.encode(null), ParameterError);
});

test("sqlite: Standard Query applies the existing scalar cast checks", () => {
  const query = defineQuery<{ id: number }, never, "none", "sqlite">({
    dialect: "sqlite", sql: "select :id", params: ["id"], checks,
    inputs: { id: { type: { kind: "scalar", name: "int" }, cast: "int", nullable: false } },
  });
  assert.throws(() => {
    // @ts-expect-error The cast checks also protect untyped callers at runtime.
    encode(query, { id: "not an integer" });
  }, ParameterError);
});

test("sqlite: Standard Query preserves boolean and JSON encoding and decoding", () => {
  const query = defineQuery<{ enabled: boolean; payload: { value: number } }, { enabled: boolean; payload: { value: number } }, "one", "sqlite">({
    dialect: "sqlite", sql: "select :enabled, :payload", params: ["enabled", "payload"],
    inputs: {
      enabled: { type: { kind: "scalar", name: "bool" } },
      payload: { type: { kind: "json" } },
    },
    columns: [["enabled", "bool"], ["payload", "json"]], cardinality: "one",
  });
  const values = encode(query, { enabled: true, payload: { value: 7 } });
  assert.equal(query["~standard"].query.text, "select ?, ?");
  assert.deepEqual(values, [1, '{"value":7}']);
  assert.deepEqual(query["~standard"].query.decode([values]), { enabled: true, payload: { value: 7 } });
});

test("sqlite: a no-input Standard Query accepts omitted input and preserves sqlcommenter", () => {
  const query = defineQuery<{}, never, "none", "sqlite">({
    dialect: "sqlite", sql: "select 1;", params: [], source: "queries/one.sql", sqlcommenter: true,
  });
  assert.deepEqual(encode(query), []);
  assert.equal(query["~standard"].query.text, "select 1 /*file='queries%2Fone.sql'*/;");
});

test("sqlite: Standard Query applies every result cardinality", () => {
  for (const cardinality of ["many", "one", "maybeOne", "none"] as const) {
    const query = defineQuery<{}, { id: number }, typeof cardinality, "sqlite">({
      dialect: "sqlite", sql: "select 1 as id", params: [], columns: [["id", "int"]], cardinality, source: "queries/one.sql",
    })["~standard"].query;
    if (cardinality === "many") assert.deepEqual(query.decode([[1], [2]]), [{ id: 1 }, { id: 2 }]);
    if (cardinality === "none") assert.equal(query.decode([]), undefined);
    if (cardinality === "one" || cardinality === "maybeOne") {
      assert.deepEqual(query.decode([[1]]), { id: 1 });
      assert.throws(() => query.decode([[1], [2]]), /queries\/one.sql: Expected .* row, got 2/);
      if (cardinality === "one") assert.throws(() => query.decode([]), /Expected exactly one row, got 0/);
      else assert.equal(query.decode([]), null);
    }
  }
});

// Checked by the normal TypeScript task, never executed.
function inferredInputTypes() {
  encode(insert, { id: 1, name: "Ada" });
  // @ts-expect-error Required input objects cannot be left out.
  encode(insert);
  // @ts-expect-error SQL input types stay checked at the native batch boundary.
  encode(insert, { id: "1", name: "Ada" });
  // @ts-expect-error There is no custom compile API.
  insert.compile({ id: 1, name: "Ada" });
}

test("sqlite: Standard Query writes execute in a native transaction and commit together", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("create table users (id integer primary key, name text not null, note text)");
  const statement = db.prepare(insert["~standard"].query.text);
  const inputs = [{ id: 1, name: "Ada" }, { id: 2, name: "Lin" }];
  const parameters = inputs.map((input) => encode(insert, input));
  assert.deepEqual(db.prepare("select * from users").all(), []);
  db.exec("begin");
  parameters.forEach((values) => statement.run(...values));
  db.exec("commit");
  assert.deepEqual(db.prepare("select id, name, note from users order by id").all().map((row) => ({ ...row })), [
    { id: 1, name: "Ada", note: null }, { id: 2, name: "Lin", note: null },
  ]);
});

test("sqlite: a later native constraint failure can roll back every Standard Query write", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("create table users (id integer primary key, name text not null, note text)");
  const statement = db.prepare(insert["~standard"].query.text);
  const parameters = [encode(insert, { id: 1, name: "Ada" }), encode(insert, { id: 1, name: "Lin" })];
  db.exec("begin");
  assert.throws(() => parameters.forEach((values) => statement.run(...values)), /UNIQUE constraint failed/);
  db.exec("rollback");
  assert.deepEqual(db.prepare("select * from users").all(), []);
});
