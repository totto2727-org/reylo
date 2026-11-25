// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { checks, defineQuery } from '#reylo-source/index.ts';
import type { StandardQueryV1 } from '#reylo-source/index.ts';
import { ParameterError } from "#reylo-source/values.ts";
import { plain, NO_ROW, SQL_NULL } from "./helpers.ts";
import type { EmptyParameters } from "./helpers.ts";

const insert = defineQuery<{ id: number; name: string; note?: string | null }, never, "none", "sqlite">({
  cardinality: "none",
  columns: [],
  dialect: "sqlite",
  inputs: {
    id: { nullable: false, type: { kind: "scalar", name: "int" } },
    name: { nullable: false, type: { kind: "scalar", name: "text" } },
    note: { nullable: true, type: { kind: "scalar", name: "text" } },
  },
  order: ["id", "name", "note"],
  params: ["id", "name", "note"],
  source: "queries/insert_user.sql",
  sql: "insert into users (id, name, note) values (:id, :name, :note)",
  text: "insert into users (id, name, note) values (?, ?, ?)",
});

// A generic consumer checks inferred inputs, then passes them unchanged to Standard Query.
const encode = function <Q extends StandardQueryV1<unknown, unknown, "sqlite">>(query: Q, ...args: StandardQueryV1.InferArgs<Q>): Readonly<StandardQueryV1.RawValue<"sqlite">[]> {
  return query["~standard"].query.encode(args[0]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Standard Query uses positional SQL and the compiled binding order", () => {
  const query = defineQuery<{ id: number; name: string }, never, "none", "sqlite">({
    dialect: "sqlite", order: ["id", "name", "id"], params: ["name", "id"],
    sql: "select :id, :name, :id", text: "select ?, ?, ?",
  });
  assert.equal(query["~standard"].query.text, "select ?, ?, ?");
  assert.deepEqual(encode(query, { id: 7, name: "Ada" }), [7, "Ada", 7]);
  assert.equal("compile" in query, false);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Standard Query binds omitted and explicit nullable inputs as SQL NULL", () => {
  assert.deepEqual(encode(insert, { id: 1, name: "Ada" }), [1, "Ada", SQL_NULL]);
  assert.deepEqual(encode(insert, { id: 1, name: "Ada", note: SQL_NULL }), [1, "Ada", SQL_NULL]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Standard Query refuses a missing required input", () => {
  assert.throws(() => {
    // @ts-expect-error A required query input cannot be omitted.
    encode(insert, { name: "Ada" });
  }, { message: 'Parameter "id" is missing, and the statement takes no null for it: pass a value.', name: "TypeError" });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Standard Query refuses null required inputs and positional arrays", () => {
  assert.throws(() => {
    // @ts-expect-error A required number cannot be SQL NULL.
    encode(insert, { id: SQL_NULL, name: "Ada" });
  }, ParameterError);
  assert.throws(() => {
    // @ts-expect-error Query inputs are named objects, not positional arrays.
    encode(insert, [1, "Ada"]);
  }, ParameterError);
  assert.throws(() => insert["~standard"].query.encode(SQL_NULL), ParameterError);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Standard Query applies the existing scalar cast checks", () => {
  const query = defineQuery<{ id: number }, never, "none", "sqlite">({
    checks, dialect: "sqlite", inputs: { id: { cast: "int", nullable: false, type: { kind: "scalar", name: "int" } } }, params: ["id"],
    sql: "select :id",
  });
  assert.throws(() => {
    // @ts-expect-error The cast checks also protect untyped callers at runtime.
    encode(query, { id: "not an integer" });
  }, ParameterError);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Standard Query preserves boolean and JSON encoding and decoding", () => {
  const query = defineQuery<{ enabled: boolean; payload: { value: number } }, { enabled: boolean; payload: { value: number } }, "one", "sqlite">({
    cardinality: "one", columns: [["enabled", "bool"], ["payload", "json"]], dialect: "sqlite",
    inputs: {
      enabled: { type: { kind: "scalar", name: "bool" } },
      payload: { type: { kind: "json" } },
    },
    params: ["enabled", "payload"], sql: "select :enabled, :payload",
  });
  const values = encode(query, { enabled: true, payload: { value: 7 } });
  assert.equal(query["~standard"].query.text, "select ?, ?");
  assert.deepEqual(values, [1, '{"value":7}']);
  assert.deepEqual(query["~standard"].query.decode([values]), { enabled: true, payload: { value: 7 } });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: a no-input Standard Query accepts omitted input and preserves sqlcommenter", () => {
  const query = defineQuery<EmptyParameters, never, "none", "sqlite">({
    dialect: "sqlite", params: [], source: "queries/one.sql", sql: "select 1;", sqlcommenter: true,
  });
  assert.deepEqual(encode(query), []);
  assert.equal(query["~standard"].query.text, "select 1 /*file='queries%2Fone.sql'*/;");
});

const checkSingletonCardinality = function (
  query: StandardQueryV1.Query<unknown, "sqlite">,
  cardinality: "one" | "maybeOne",
): void {
  assert.deepEqual(query.decode([[1]]), { id: 1 });
  assert.throws(() => query.decode([[1], [2]]), /queries\/one.sql: Expected .* row, got 2/u);
  if (cardinality === "one") {assert.throws(() => query.decode([]), /Expected exactly one row, got 0/u);}
  else {assert.equal(query.decode([]), NO_ROW);}
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Standard Query applies every result cardinality", () => {
  Iterator.from(["many", "one", "maybeOne", "none"] as const).forEach((cardinality) => {
    const {query} = defineQuery<EmptyParameters, { id: number }, typeof cardinality, "sqlite">({
      cardinality, columns: [["id", "int"]], dialect: "sqlite", params: [], source: "queries/one.sql", sql: "select 1 as id",
    })["~standard"];
    if (cardinality === "many") {assert.deepEqual(query.decode([[1], [2]]), [{ id: 1 }, { id: 2 }]);}
    if (cardinality === "none") {assert.equal(query.decode([]), undefined);}
    if (cardinality === "one" || cardinality === "maybeOne") {
      checkSingletonCardinality(query, cardinality);
    }
  });
});

// Checked by the normal TypeScript task, never executed.
export const inferredInputTypes = function (): void {
  encode(insert, { id: 1, name: "Ada" });
  // @ts-expect-error Required input objects cannot be left out.
  encode(insert);
  // @ts-expect-error SQL input types stay checked at the native batch boundary.
  encode(insert, { id: "1", name: "Ada" });
  // @ts-expect-error There is no custom compile API.
  insert.compile satisfies never;
};

const commitWrites = function (
  db: DatabaseSync,
  statement: ReturnType<DatabaseSync["prepare"]>,
  parameters: Readonly<Readonly<StandardQueryV1.RawValue<"sqlite">[]>[]>,
): void {
  db.exec("begin");
  parameters.forEach((values) => {statement.run(...values);});
  db.exec("commit");
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Standard Query writes execute in a native transaction and commit together", (testContext) => {
  const db = new DatabaseSync(":memory:");
  testContext.after(() => {db.close();});
  db.exec("create table users (id integer primary key, name text not null, note text)");
  const statement = db.prepare(insert["~standard"].query.text);
  const inputs = [{ id: 1, name: "Ada" }, { id: 2, name: "Lin" }];
  const parameters = inputs.map((input) => encode(insert, input));
  assert.deepEqual(db.prepare("select * from users").all(), []);
  commitWrites(db, statement, parameters);
  assert.deepEqual(plain(db.prepare("select id, name, note from users order by id").all()), [
    { id: 1, name: "Ada", note: SQL_NULL }, { id: 2, name: "Lin", note: SQL_NULL },
  ]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: a later native constraint failure can roll back every Standard Query write", (testContext) => {
  const db = new DatabaseSync(":memory:");
  testContext.after(() => {db.close();});
  db.exec("create table users (id integer primary key, name text not null, note text)");
  const statement = db.prepare(insert["~standard"].query.text);
  const parameters = [encode(insert, { id: 1, name: "Ada" }), encode(insert, { id: 1, name: "Lin" })];
  db.exec("begin");
  assert.throws(() => {parameters.forEach((values) => {statement.run(...values);});}, /UNIQUE constraint failed/u);
  db.exec("rollback");
  assert.deepEqual(db.prepare("select * from users").all(), []);
});
