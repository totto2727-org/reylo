// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import type { EngineType } from "#reylo-source/engine.ts";
import { orNull, renderParamType, renderType } from "#reylo-source/render.ts";
import { typeSchema } from "#reylo-source/schema.ts";
import { matchesUndefined } from "#reylo-source/native-predicates.ts";

const scalar = (name: string): EngineType => ({ kind: "scalar", name });
const field = (name: string, type: EngineType, nullable: boolean): { name: string; nullable: boolean; type: EngineType } => ({ name, nullable, type });

// A table's row type as the engine renders it once the catalog gave its columns.
const users: EngineType = {
  fields: [
    field("id", scalar("int8"), false),
    field("seen", scalar("timestamptz"), true),
    field("tags", { kind: "array", of: scalar("text") }, true),
    field("mood", { kind: "enum", labels: ["ok", "sad"], name: "mood" }, false),
  ],
  kind: "composite",
  name: "users",
};
// `json_build_object('author', u, 'posts', json_agg(p), 'n', count(*))`: a composite inside a document.
const doc: EngineType = {
  fields: [
    field("author", users, false),
    field("posts", { kind: "list", nullable_items: true, of: users }, true),
    field("n", scalar("int8"), false),
  ],
  kind: "object",
};

const inJson = `{ id: number; seen: string | null; tags: (string | null)[] | null; mood: "ok" | "sad" }`;

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a composite is its row's text on the wire", () => {
  assert.equal(renderType(users, false, "postgres"), "string");
  assert.equal(renderType({ kind: "array", of: users }, false, "postgres"), "string");
  assert.equal(renderParamType(users, "postgres"), "string");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("inside a JSON document a composite is an object of its JSON-encoded fields", () => {
  assert.equal(renderType(users, true, "postgres"), inJson);
  // The renderer parenthesizes an element whose text holds a `|` anywhere, as it does for an object.
  assert.equal(renderType({ kind: "array", of: users }, true, "postgres"), `(${inJson} | null)[]`);
  // A constructor's fields are inside the document, at the top level too.
  const expected = `{ author: ${inJson}; posts: (${inJson} | null)[] | null; n: number }`;
  assert.equal(renderType(doc, false, "postgres"), expected);
  assert.equal(renderType(doc, true, "postgres"), expected);
});

const wire = (name: string, dialect: "postgres" | "mysql" = "postgres"): string => renderType(scalar(name), false, dialect);

const assertPostgresScalarTypes = (): void => {
  assert.deepEqual(["bool", "int2", "int4", "oid", "float4", "float8"].map((name) => wire(name)), ["boolean", "number", "number", "number", "number", "number"]);
  assert.equal(wire("int8"), "bigint");
  assert.deepEqual(["numeric", "money", "date", "timestamp", "timestamptz", "time", "timetz", "interval", "uuid", "text"].map((name) => wire(name)), Array.from({ length: 10 }, () => "string"));
  assert.equal(wire("bytea"), "Uint8Array");
  assert.equal(renderType({ kind: "json" }), "Json");
  // Every other type is its text: Reylo owns every oid, so no driver parses one.
  assert.deepEqual(["point", "xid", "int4range", "void", "record", "tsvector", "citext"].map((name) => wire(name)), Array.from({ length: 7 }, () => "string"));
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("one type per SQL type, on every driver: what the run time returns (src/values.ts)", () => {
  assertPostgresScalarTypes();
  // An array of each, an enum's labels, a row value's array its text.
  assert.equal(renderType({ kind: "array", of: scalar("timestamptz") }), "(string | null)[]");
  assert.equal(renderType({ kind: "array", of: scalar("int8") }), "(bigint | null)[]");
  assert.equal(renderType({ kind: "array", of: { kind: "enum", labels: ["ok", "sad"], name: "mood" } }), `("ok" | "sad" | null)[]`);
  // MySQL's types are the same names: a BIGINT a BigInt, a DECIMAL its text, a DATETIME its text, a
  // BIT its bytes, and a truth value (a TINYINT(1), a BIT(1), a comparison) a boolean.
  assert.equal(wire("int8", "mysql"), "bigint");
  assert.deepEqual(["numeric", "timestamp", "date", "time", "text"].map((name) => wire(name, "mysql")), Array.from({ length: 5 }, () => "string"));
  assert.equal(wire("bytea", "mysql"), "Uint8Array");
  assert.equal(wire("bool", "mysql"), "boolean");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a scalar that names two types is either", () => {
  // What MySQL answers with by what is bound for a placeholder: a BIGINT is a BigInt, a DOUBLE a
  // Number; an INT a temporary table may widen to a BIGINT is a BigInt either way.
  assert.equal(renderType(scalar("int8|float8"), false, "mysql"), "bigint | number");
  assert.equal(renderType(scalar("int8|int4"), false, "mysql"), "bigint");
  assert.equal(renderType(scalar("numeric|float8"), false, "mysql"), "string | number");
  assert.equal(renderType(scalar("date|timestamp"), false, "mysql"), "string");
  assert.equal(renderType({ kind: "array", of: scalar("numeric|float8") }, false, "mysql"), "(string | number | null)[]");
  // A truth value a document may hold as `true` or as 1.
  assert.equal(renderType(scalar("bool|int8"), true, "mysql"), "boolean | number");
  assert.equal(renderType({ kind: "list", nullable_items: true, of: scalar("bool|int8") }, false, "mysql"), "(boolean | number | null)[]");
  // A part no table spells is nothing known inside a document.
  assert.equal(renderType(scalar("int8|mystery"), true, "mysql"), "Json");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("pgvector's vector and halfvec are arrays of numbers, as columns and as parameters; inside a document their text", () => {
  Iterator.from(["vector", "halfvec"]).forEach((name) => {
    assert.equal(renderType(scalar(name), false, "postgres"), "number[]");
    assert.equal(renderType(scalar(name), true, "postgres"), "string");
    assert.equal(renderParamType(scalar(name), "postgres"), "number[]");
    assert.equal(renderType({ kind: "array", of: scalar(name) }, false, "postgres"), "(number[] | null)[]");
    assert.equal(renderParamType({ kind: "array", of: scalar(name) }, "postgres"), "number[][]");
    assert.deepEqual(typeSchema(scalar(name), "postgres"), { items: { format: "float", type: "number" }, type: "array" });
    assert.deepEqual(typeSchema(scalar(name), "postgres", false, true), { type: "string" });
  });
  // A sparsevec stays its text.
  assert.equal(renderType(scalar("sparsevec"), false, "postgres"), "string");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an hstore is an object of nullable text, as a column, a parameter and inside a document", () => {
  assert.equal(renderType(scalar("hstore"), false, "postgres"), "Record<string, string | null>");
  assert.equal(renderParamType(scalar("hstore"), "postgres"), "Record<string, string | null>");
  assert.equal(renderType({ kind: "array", of: scalar("hstore") }, false, "postgres"), "(Record<string, string | null> | null)[]");
  assert.deepEqual(typeSchema(scalar("hstore"), "postgres"), { additionalProperties: { type: ["string", "null"] }, type: "object" });
  assert.equal(renderType(scalar("hstore"), true, "postgres"), "Record<string, string | null>");
  assert.equal(renderType({ kind: "list", nullable_items: false, of: scalar("hstore") }, false, "postgres"), "(Record<string, string | null>)[]");
  assert.deepEqual(typeSchema(scalar("hstore"), "postgres", false, true), { additionalProperties: { type: ["string", "null"] }, type: "object" });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("inside a document an oid is its text, a geometry its GeoJSON, and an extension's type with no cast to JSON its text", () => {
  // Postgres writes JSON numbers only for the integers, the floats and numeric: `{"o" : "7"}`.
  assert.equal(renderType(scalar("oid"), false, "postgres"), "number");
  assert.equal(renderType(scalar("oid"), true, "postgres"), "string");
  assert.deepEqual(typeSchema(scalar("oid"), "postgres", false, true), { type: "string" });
  // PostGIS's cast to JSON writes GeoJSON: `{"type":"Point","coordinates":[1,2]}`.
  assert.equal(renderType(scalar("geometry"), false, "postgres"), "string");
  assert.equal(renderType(scalar("geometry"), true, "postgres"), "{ type: string; [key: string]: Json | undefined }");
  assert.deepEqual(typeSchema(scalar("geometry"), "postgres", false, true), { description: "a GeoJSON geometry", properties: { type: { type: "string" } }, required: ["type"], type: "object" });
  // A pgvector vector, a geography, a cube or an isbn inside a document is the JSON string of its text: `{"v" : "[1,2,3]"}`.
  Iterator.from(["vector", "halfvec", "sparsevec", "geography", "cube", "seg", "isbn", "semver", "ulid", "point"]).forEach((name) => {assert.equal(renderType(scalar(name), true, "postgres"), "string", name);});
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a composite with no columns inside a document is an empty object", () => {
  assert.equal(renderType({ fields: [], kind: "composite", name: "empty" }, true), "Record<never, never>");
  assert.equal(renderType({ fields: [], kind: "composite", name: "empty" }, false), "string");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: an INTEGER is a number, exact or an error; a NUMERIC whichever the row stored; a column with no type unknown", () => {
  assert.equal(renderType(scalar("integer"), false, "sqlite"), "number");
  assert.equal(renderType(scalar("numeric"), false, "sqlite"), "number | string");
  assert.equal(renderType(scalar("real"), false, "sqlite"), "number");
  assert.equal(renderType(scalar("text"), false, "sqlite"), "string");
  assert.equal(renderType(scalar("blob"), false, "sqlite"), "Uint8Array");
  assert.equal(renderType(scalar("bool"), false, "sqlite"), "boolean");
  assert.equal(renderType({ kind: "unknown" }, false, "sqlite"), "unknown");
  // The driver binds a number for an INTEGER, and the run time a truth value as 1 or 0.
  assert.equal(renderParamType(scalar("integer"), "sqlite"), "number");
  assert.equal(renderParamType(scalar("numeric"), "sqlite"), "number | string | boolean");
});

// Each column type beside the type the engine gives a parameter compared with that column, as
// The engine reported them on 2026-10-20 against Postgres 18.6, MySQL 8.4.11 and SQLite for the
// Driver matrix's `typed` fixture (`select c from typed` and `select id from typed where c = :v`).
// MySQL describes every integer context as a BIGINT and a BIT one as BIT, so the engine types a
// Parameter by the column it is compared with (upstream engine/mysql `column_types`), and keeps the
// Prepare's (`int4`, `bool|bytea`) for an expression; SQLite types a parameter by the column's
// Affinity, a BOOLEAN column's being NUMERIC.
const array = (of: EngineType): EngineType => ({ kind: "array", of });
const composite: EngineType = { fields: [field("name", scalar("text"), true)], kind: "composite", name: "user_in" };
type RoundTripDialect = "postgres" | "mysql" | "sqlite";
type TypePair = [column: EngineType, param: EngineType];

const ROUND_TRIPS: [dialect: RoundTripDialect, pairs: TypePair[]][] = [
  ["postgres", [
    ...["int2", "int4", "int8", "float4", "float8", "numeric", "bool", "text", "uuid", "interval", "time", "money", "date", "timestamp", "timestamptz", "bytea"].map((name): TypePair => [scalar(name), scalar(name)]),
    [{ kind: "json" }, { kind: "json" }],
    [{ kind: "enum", labels: ["ok", "sad"], name: "mood" }, { kind: "enum", labels: ["ok", "sad"], name: "mood" }],
    ...["int4", "int8", "text", "bool", "timestamptz", "date", "bytea", "numeric"].map((name): TypePair => [array(scalar(name)), array(scalar(name))]),
    [array({ kind: "enum", labels: ["ok", "sad"], name: "mood" }), array({ kind: "enum", labels: ["ok", "sad"], name: "mood" })],
    [array(composite), array(composite)],
    [array(scalar("record")), array(scalar("record"))],
    // An array the statement builds from values that may be NULL (`array_agg` over a left join)
    // Goes back into a structured member alone: a top-level array parameter takes no NULL
    // Element, tested below.
  ]],
  ["mysql", [
    [scalar("int8"), scalar("int8")],
    [scalar("int4"), scalar("int4")],
    [scalar("int2"), scalar("int4")],
    [scalar("bool"), scalar("bool|int4")],
    [scalar("bool"), scalar("bool|bytea")],
    [scalar("bytea"), scalar("bool|bytea")],
    [scalar("bytea"), scalar("bytea")],
    ...["numeric", "float8", "text", "date", "timestamp", "time"].map((name): TypePair => [scalar(name), scalar(name)]),
    [{ kind: "json" }, { kind: "json" }],
  ]],
  ["sqlite", [
    ...["integer", "int8", "real", "text", "blob", "numeric"].map((name): TypePair => [scalar(name), scalar(name)]),
    [scalar("bool"), scalar("numeric")],
    [{ kind: "unknown" }, { kind: "unknown" }],
  ]],
];

const element = (typeText: string): string | undefined =>
  typeText.endsWith("[]") ? typeText.slice(0, -2).replace(/^\((?<members>.*)\)$/u, "$<members>") : undefined;

const members = (typeText: string): string[] => typeText.split(" | ");

const admits = function (column: EngineType, param: EngineType, dialect: RoundTripDialect): boolean {
  const returned = renderType(column, false, dialect);
  const taken = renderParamType(param, dialect);
  const returnedElement = element(returned);
  const takenElement = element(taken);
  // A returned array may hold null. Its parameter accepts every other element type.
  if (!matchesUndefined(returnedElement) && !matchesUndefined(takenElement)) {
    const accepted = members(takenElement);
    return members(returnedElement).filter((member) => member !== "null").every((member) => accepted.includes(member) || accepted.includes("unknown"));
  }
  const accepted = members(taken);
  return accepted.includes("unknown") || members(returned).every((member) => accepted.includes(member));
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a parameter takes every value run returns for the column it is compared with, on every dialect: the round-trip rule", () => {
  ROUND_TRIPS.forEach(([dialect, pairs]) => {
    pairs.forEach(([column, param]) => {
      assert.ok(admits(column, param, dialect), `${dialect}: a column of ${JSON.stringify(column)} returns ${renderType(column, false, dialect)}, which a parameter of ${JSON.stringify(param)}, typed ${renderParamType(param, dialect)}, does not take`);
    });
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("parameters take what every driver binds, whatever Reylo returns", () => {
  assert.equal(renderParamType(scalar("numeric"), "postgres"), "string");
  assert.equal(renderParamType(scalar("int8"), "postgres"), "number | bigint | string");
  assert.equal(renderParamType(scalar("blob"), "sqlite"), "Uint8Array");
  assert.equal(renderParamType(scalar("bytea"), "mysql"), "Uint8Array");
  // A JSON value, built by the statement or read from a column, is parsed.
  const built: EngineType = { fields: [field("id", scalar("int4"), false)], kind: "object" };
  assert.equal(renderType(built, false, "mysql"), "{ id: number }");
  // Inside a JSON value the database wrote the bytes and the number already.
  const inner: EngineType = { fields: [field("b", scalar("bytea"), false), field("n", scalar("numeric"), false)], kind: "object" };
  // A non-finite decimal or float is the text Postgres writes inside a document (`{"n": "NaN"}`);
  // MySQL stores none.
  assert.equal(renderType(inner, false, "postgres"), '{ b: string; n: number | "NaN" | "Infinity" | "-Infinity" }');
  assert.equal(renderType(inner, false, "mysql"), "{ b: string; n: number }");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("two columns or keys of one name keep the last, as a row object and JSON.parse do", () => {
  const object: EngineType = { fields: [field("x", scalar("text"), false), field("x", scalar("int4"), true)], kind: "object" };
  assert.equal(renderType(object, false, "postgres"), "{ x: number | null }");
  // A row whose columns were not read (a subquery's) is an object of them inside a document.
  assert.equal(renderType({ kind: "list", nullable_items: false, of: scalar("record") }, false, "postgres"), "Record<string, Json>[]");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("every date and time parameter takes a string: a timestamptz one the text that names its zone, which run returns, and no Date", () => {
  assert.equal(renderParamType(scalar("timestamptz"), "postgres"), "string");
  assert.equal(renderParamType({ kind: "array", of: scalar("timestamptz") }, "postgres"), "string[]");
  Iterator.from(["timestamp", "date"]).forEach((name) => {
    assert.equal(renderParamType(scalar(name), "postgres"), "string");
    assert.equal(renderParamType(scalar(name), "mysql"), "string");
    assert.equal(renderParamType({ kind: "array", of: scalar(name) }, "postgres"), "string[]");
  });
  // What MySQL answers by what is bound for a placeholder compared with a DATE and a DATETIME.
  assert.equal(renderParamType(scalar("date|timestamp"), "mysql"), "string");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a JSON value nothing constrains is any JSON value, Json, and so is a value nothing types inside JSON the statement builds", () => {
  Iterator.from(["postgres", "mysql", "sqlite", "duckdb"] as const).forEach((dialect) => {
    assert.equal(renderType({ kind: "json" }, false, dialect), "Json");
    assert.equal(renderParamType({ kind: "json" }, dialect), "Json");
  });
  // Json admits null, which a NOT NULL jsonb column can hold, so a nullable one reads the same.
  assert.equal(orNull("Json"), "Json");
  assert.equal(orNull("string"), "string | null");
  assert.equal(renderType({ kind: "array", of: { kind: "json" } }), "Json[]");
  assert.equal(renderType({ kind: "list", nullable_items: true, of: { kind: "unknown" } }), "Json[]");
  assert.equal(renderType({ fields: [field("k", { kind: "unknown" }, true), field("n", { kind: "json" }, false), field("s", { kind: "scalar", name: "text" }, true)], kind: "object" }), "{ k: Json; n: Json; s: string | null }");
  assert.equal(renderType(scalar("mystery"), true, "postgres"), "Json");
  // Outside JSON, a value nothing types may be any value: SQLite's json_extract, a column with no declared type.
  assert.equal(renderType({ kind: "unknown" }, false, "sqlite"), "unknown");
  assert.equal(renderType({ fields: [{ name: "j", nullable: true, type: { kind: "json" } }, { name: "u", nullable: true, type: { kind: "unknown" } }], kind: "struct" }, false, "duckdb"), "{ j: Json; u: unknown | null }");
});
