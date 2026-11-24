// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { validate, withDefaults } from "#reylo-source/json-schema.ts";

// The run time's JSON Schema 2020-12 validator (src/json-schema.ts). The official JSON Schema Test
// Suite runs over it in lab/json-schema-suite; these are the rules Reylo adds or decides.

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a default fills a key the value leaves out, never a null one, and never inside a union member", () => {
  const schema = {
    type: "object",
    properties: { done: { type: "boolean", default: false }, tags: { type: "array", default: [] }, note: { type: ["string", "null"], default: "x" } },
    anyOf: [{ properties: { kind: { default: "a" } } }],
  };
  const value = { note: null };
  assert.deepEqual(withDefaults(schema, value), { done: false, note: null, tags: [] });
  // The caller's value is left as it was, and each default is a copy.
  assert.deepEqual(value, { note: null });
  const a = withDefaults(schema, {}) as { tags: unknown[] };
  a.tags.push(1);
  assert.deepEqual((withDefaults(schema, {}) as { tags: unknown[] }).tags, []);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("defaults follow the value into nested objects, arrays, allOf, and the branch `if` picks", () => {
  const schema = {
    type: "array",
    items: { type: "object", properties: { n: { default: 1 } }, if: { required: ["big"] }, then: { properties: { size: { default: "L" } } }, else: { properties: { size: { default: "S" } } } },
    allOf: [{ prefixItems: [{ default: { first: true } }] }],
  };
  assert.deepEqual(withDefaults(schema, [{ big: true }, {}]), [{ big: true, n: 1, size: "L" }, { n: 1, size: "S" }]);
  assert.deepEqual(withDefaults({ prefixItems: [{ default: 1 }, { default: 2 }] }, []), [1, 2]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a failure names its place as a JSON Pointer", () => {
  const schema = { type: "object", properties: { "a/b": { type: "array", items: { type: "integer", minimum: 0 } } }, unevaluatedProperties: false };
  assert.deepEqual(validate(schema, { "a/b": [1, -1] }), { message: "must be at least 0", path: "/a~1b/1" });
  assert.deepEqual(validate(schema, { c: 1 }), { message: "is a key the schema does not allow", path: "/c" });
  assert.equal(validate(schema, { "a/b": [] }), undefined);
  // A format is asserted.
  assert.deepEqual(validate({ type: "string", format: "date-time" }, "2026-13-01T00:00:00Z"), { message: "must be a date-time", path: "" });
  assert.equal(validate({ type: "string", format: "date-time" }, "2026-10-20T10:00:00.5+02:00"), undefined);
});
