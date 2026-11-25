// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import type { EngineType, JsonSchema } from "#reylo-source/engine-type.ts";
import { renderParamType, renderType } from "#reylo-source/render.ts";
import { typeSchema } from "#reylo-source/schema.ts";
import { matchesUndefined } from "#reylo-source/native-predicates.ts";

import { SQL_NULL } from "./helpers.ts";

const scalar = (name: string): EngineType => ({ kind: "scalar", name });
const json = (schema: JsonSchema): EngineType => ({ kind: "json", schema });

const assertStructuredColumns = (): void => {
  const tagged = { anyOf: [
    { additionalProperties: false, properties: { kind: { enum: ["a"] }, x: { type: "number" } }, required: ["kind", "x"], type: "object" },
    { additionalProperties: false, properties: { kind: { enum: ["b"] } }, required: ["kind"], type: "object" },
  ] };
  assert.equal(renderType(json(tagged)), `{ kind: "a"; x: number } | { kind: "b" }`);
  assert.equal(renderType(json({ enum: [{ a: 1, "b-c": [true, SQL_NULL] }, "x", 2, SQL_NULL] })), `{ a: 1; "b-c": [true, null] } | "x" | 2 | null`);
  assert.equal(renderType(json({ items: { type: "boolean" }, minItems: 1, prefixItems: [{ type: "string" }, { type: ["number", "null"] }], type: "array" })), "[string, (number | null)?, ...boolean[]]");
  assert.equal(renderType(json({ items: false, minItems: 1, prefixItems: [{ type: "string" }], type: "array" })), "[string]");
  assert.equal(renderType(json({ items: { type: ["string", "integer"] }, type: "array" })), "(string | number)[]");
  assert.equal(renderType(json({ items: false, type: "array" })), "[]");
  assert.equal(renderType(json(false)), "never");
  assert.equal(renderType(json({})), "Json");
  assert.equal(renderType(json({ type: "array" })), "Json[]");
};

const texts = (nullableItems?: boolean): EngineType => (matchesUndefined(nullableItems) ? { kind: "array", of: scalar("text") } : { kind: "array", nullable_items: nullableItems, of: scalar("text") });

const assertArraySchemas = (member: EngineType): void => {
  // The JSON Schemas say the same.
  assert.deepEqual(typeSchema(texts(), "postgres"), { items: { type: ["string", "null"] }, type: "array" });
  assert.deepEqual(typeSchema(texts(false), "postgres"), { items: { type: "string" }, type: "array" });
  assert.deepEqual(typeSchema(texts(), "postgres", true), { items: { type: "string" }, type: "array" });
  assert.deepEqual(typeSchema(member, "postgres", true), { additionalProperties: false, properties: { tags: { items: { type: ["string", "null"] }, type: "array" } }, required: ["tags"], type: "object" });
};

const assertNullableResultItems = (): void => {
  // Postgres lets any array hold NULL elements, whatever a column's NOT NULL says: a table's array
  // Column is `(T | null)[]`, and so is `array_agg(u.email)` over a LEFT JOIN, `{NULL}` for a team
  // With no users. An array the statement builds from values it shows are not NULL is `T[]`.
  assert.equal(renderType(texts()), "(string | null)[]");
  assert.equal(renderType(texts(false)), "string[]");
  assert.equal(renderType(texts(true)), "(string | null)[]");
  assert.equal(renderType(texts(true), true), "(string | null)[]");
  assert.equal(renderType({ kind: "array", nullable_items: true, of: { kind: "enum", labels: ["ok", "sad"], name: "mood" } }), `("ok" | "sad" | null)[]`);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a returned array's elements may be NULL unless the statement shows they are not; a parameter's are strict", () => {
  assertNullableResultItems();
  // A top-level array parameter's elements take no NULL, as the parameter itself takes NULL only
  // When cast to `nullable(…)` or written bare to a nullable column: a NULL in `= any(:ids)`
  // Matches nothing. An array inside a
  // Structured parameter's member keeps NULL elements, so a built array goes back into a row.
  assert.equal(renderParamType(texts()), "string[]");
  assert.equal(renderParamType({ kind: "array", of: scalar("int8") }), "(number | bigint | string)[]");
  assert.equal(renderParamType({ kind: "array", of: scalar("int4") }), "number[]");
  const member: EngineType = { fields: [{ name: "tags", nullable: false, optional: false, type: texts(), written: "text[]" }], kind: "rows", one: true };
  assert.equal(renderParamType(member), "{ tags: (string | null)[] }");
  assertArraySchemas(member);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a JSON column a CHECK holds to a JSON Schema is the type of the values the schema admits", () => {
  const open = {
    additionalProperties: true,
    properties: Object.fromEntries([["name", { type: "string" }], ["age", { type: ["integer", "null"] }]]),
    required: ["name"],
    type: "object",
  };
  assert.equal(renderType(json(open)), "{ name: string; age?: number | null; [key: string]: Json | undefined }");
  assert.equal(renderType(json({ ...open, additionalProperties: false })), "{ name: string; age?: number | null }");
  assert.equal(renderType(json({ additionalProperties: { type: "string" }, type: "object" })), "{ [key: string]: string }");
  assert.equal(renderType(json({ additionalProperties: false, type: "object" })), "Record<never, never>");
  assert.equal(renderType(json({ type: ["object", "null"] })), "Record<string, Json> | null");
  // A discriminated union, a literal object, a tuple with an optional element and a rest.
  assertStructuredColumns();
  // Reylo parses JSON on every driver; inside a document, and as a parameter, the schema's type stands.
  assert.equal(renderType(json(open), true, "postgres"), "{ name: string; age?: number | null; [key: string]: Json | undefined }");
  assert.equal(renderParamType(json(open), "postgres"), "{ name: string; age?: number | null; [key: string]: Json | undefined }");
  assert.equal(renderType({ kind: "json" }), "Json");
});
