// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with the native Node test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Compare native SQLite rows and the application's generated schemas.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Verify the real SQLite defaults and JSON parameter results.
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "#reylo-source/native-predicates.ts";
import { plain, requireFixtureValue } from "./helpers.ts";
import { analysis, built, withProject } from "./structured-fixture.ts";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an imported query carries its input's and its output's JSON Schema, a structured parameter's keys included", async () => {
  await withProject("create table events (id integer primary key, ts text not null, status text not null default 'new', amount real)", async ({ root }) => {
    const query = await built(root, "insert_events", "insert into events :events::rows(id integer not null, ts text not null, status? text not null, amount real) returning id, status");
    assert.deepEqual(query.inputSchema, {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {
        events: {
          items: {
            additionalProperties: false,
            properties: { amount: { anyOf: [{ format: "double", type: "number" }, { type: "null" }] }, id: { format: "int64", type: "integer" }, status: { type: "string" }, ts: { type: "string" } },
            required: ["id", "ts"],
            type: "object",
          },
          type: "array",
        },
      },
      required: ["events"],
      type: "object",
    });
    assert.deepEqual(query.outputSchema, {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      items: { properties: { id: { format: "int64", type: "integer" }, status: { type: "string" } }, required: ["id", "status"], type: "object" },
      type: "array",
    });
    // Standard Schema's converter gives the same.
    assert.deepEqual(query["~standard"].jsonSchema.input({ target: "draft-2020-12" }), query.inputSchema);
  });
});

const checkTodoType = async function (root: string, insert: string): Promise<void> {
  const report = await analysis(root, insert);
  const parameter = requireFixtureValue(report.params[0]);
  assert.deepEqual([parameter.name, parameter.type_name, parameter.type.kind], ["todos", "json", "json"]);
  // `done` has a default, so the caller may leave it out; the run time fills it.
  assert.ok(parameter.type.kind === "json" && isRecord(parameter.type.schema) && isRecord(parameter.type.schema.items));
  assert.deepEqual(parameter.type.schema.items.required, ["title"]);
};

const checkLimitDefault = async function (root: string, database: DatabaseSync): Promise<void> {
  // A parameter whose schema has a default at its root may be left out.
  const limited = await built(root, "limited", `select id from todos order by id limit :n::json('{ "type": "integer", "minimum": 1, "maximum": 200, "default": 1 }')`);
  assert.deepEqual(plain(await limited.run(database, {})), [{ id: 1 }]);
  assert.deepEqual(plain(await limited.run(database, { n: 2 })), [{ id: 1 }, { id: 2 }]);
  await assert.rejects(limited.run(database, { n: 0 }), /Parameter "n" must be at least 1/u);
  assert.deepEqual(limited.inputSchema.required, []);
};

const checkNonlocalSchema = async function (root: string): Promise<void> {
  // What the profile refuses is the type check's error at the schema, and fails the build.
  const bad = `select * from json_each(:p::json('{ "$ref": "#/$defs/x" }'))`;
  const invalid = await analysis(root, bad);
  const currentDiagnostic = invalid.diagnostics.find((diagnostic) => diagnostic.code === 20);
  assert.ok(currentDiagnostic);
  assert.match(currentDiagnostic.message, /breaks the schema's locality/u);
  assert.equal(bad.slice(currentDiagnostic.start, currentDiagnostic.start + currentDiagnostic.length), `'{ "$ref": "#/$defs/x" }'`);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a typed JSON parameter is typed by its schema, takes its defaults, and is checked before the statement runs", async () => {
  await withProject("create table todos (id integer primary key, title text not null, done integer not null default 0)", async ({ database, root }) => {
    const insert = `insert into todos (title, done)
  select value ->> '$.title', value ->> '$.done' from json_each(:todos::json('{
    "type": "array",
    "maxItems": 2,
    "items": {
      "type": "object",
      "properties": { "title": { "type": "string", "minLength": 1 }, "done": { "type": "boolean", "default": false } },
      "required": ["title", "done"],
      "additionalProperties": false
    }
  }')) returning id, title, done`;
    await checkTodoType(root, insert);
    const query = await built(root, "insert_todos", insert);
    assert.deepEqual(plain(await query.run(database, { todos: [{ title: "a" }, { done: true, title: "b" }] })), [{ done: 0, id: 1, title: "a" }, { done: 1, id: 2, title: "b" }]);
    await assert.rejects(query.run(database, { todos: [{ title: "" }] }), /Parameter "todos" at \/0\/title must be at least 1 characters long/u);
    await assert.rejects(query.run(database, { todos: [{ extra: 1, title: "a" }] }), /at \/0\/extra is a key the schema does not allow/u);
    await assert.rejects(query.run(database, { todos: [{ title: "a" }, { title: "b" }, { title: "c" }] }), /must have at most 2 items/u);
    await checkLimitDefault(root, database);
    await checkNonlocalSchema(root);
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a JSON member of a column list is checked against its schema, its nested defaults filled", async () => {
  await withProject("create table events (id integer primary key, meta text)", async ({ database, root }) => {
    const query = await built(root, "insert_events", `insert into events :events::rows(id integer not null, meta json('{"type": "object", "properties": {"source": {"type": "string", "default": "web"}, "n": {"type": "integer", "minimum": 0}}, "required": ["source"]}')) returning id, meta`);
    // oxlint-disable-next-line eslint/sort-keys -- The fixture checks the exact serialized member order in the SQLite JSON text.
    assert.deepEqual(plain(await query.run(database, { events: [{ id: 1, meta: {} }, { id: 2, meta: { source: "app", n: 3 } }] })), [{ id: 1, meta: `{"source":"web"}` }, { id: 2, meta: `{"source":"app","n":3}` }]);
    await assert.rejects(query.run(database, { events: [{ id: 3, meta: { n: -1 } }] }), /row 1: "meta" at \/n must be at least 0/u);
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("binary data in a column list travels as hexadecimal text, which each reader decodes", async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const same = (got: unknown): void => {
    assert.ok(got instanceof Uint8Array);
    assert.deepEqual([...got], [...bytes]);
  };
  // SQLite decodes it with unhex().
  await withProject("create table files (id integer primary key, data blob not null)", async ({ database, root }) => {
    const insert = await built(root, "insert_files", "insert into files :files::rows(id integer not null, data blob not null) returning id, data");
    const [row] = await insert.run(database, { files: [{ data: bytes, id: 1 }] });
    same(requireFixtureValue(row).data);
    const read = await built(root, "read_files", "select f.data from :files::rows(data blob not null) as f");
    const [roundTrip] = await read.run(database, { files: [{ data: bytes }] });
    same(requireFixtureValue(roundTrip).data);
    await assert.rejects(insert.run(database, { files: [{ data: "00ff", id: 2 }] }), /"data" is blob, binary data, a Uint8Array; got "00ff"/u);
  });
});
