// oxlint-disable-next-line rules/no-node-imports -- Nub compares actual results and error identities through Node's assertions.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Register these integration cases with Nub's native Node test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Change the actual SQLite database to cause native failures.
import type { DatabaseSync } from "node:sqlite";
import { Predicate } from "effect";
import { defineQuery } from "@totto2727/reylo";
import { prepare, QueryDecodeError, QueryExecutionError, QueryPreparationError } from "@totto2727/reylo/effect";
import { DecodeError, ParameterError } from "#reylo-source/values.ts";
import { capture, database, evaluate, failure, lookup, seed } from "./effect-query-fixture.ts";
import { NO_ROW } from "./helpers.ts";
import type { EmptyParameters } from "./helpers.ts";

const many = defineQuery<EmptyParameters, { n: number }, "many", "sqlite">({ cardinality: "many", columns: [["n", "int"]], dialect: "sqlite", params: [], sql: "select n from numbers" });
const one = defineQuery<EmptyParameters, { n: number }, "one", "sqlite">({ cardinality: "one", columns: [["n", "int"]], dialect: "sqlite", params: [], sql: "select n from numbers" });
const maybe = defineQuery<EmptyParameters, { n: number }, "maybeOne", "sqlite">({ cardinality: "maybeOne", columns: [["n", "int"]], dialect: "sqlite", params: [], sql: "select n from numbers where n = 1" });
const none = defineQuery<EmptyParameters, never, "none", "sqlite">({ cardinality: "none", columns: [], dialect: "sqlite", params: [], sql: "delete from numbers" });

const assertOneRowRequired = (captured: ReturnType<typeof capture>): void => {
  const error = failure(captured(one));
  assert.ok(error instanceof QueryDecodeError);
  assert.ok(Predicate.isError(error.cause));
  assert.match(error.cause.message, /Expected exactly one row, got 2/u);
};

const assertRowsAfterDeletion = (db: DatabaseSync, captured: ReturnType<typeof capture>): void => {
  // oxlint-disable-next-line typescript/no-confusing-void-expression -- Assert the native no-result contract as an actual undefined value.
  assert.equal(evaluate(captured(none)), undefined);
  assert.equal(evaluate(captured(maybe)), NO_ROW);
  assert.deepEqual(evaluate(captured(many)), []);
  assert.ok(failure(captured(one)) instanceof QueryDecodeError);
  db.exec("insert into numbers values(1), (1)");
  assert.ok(failure(captured(maybe)) instanceof QueryDecodeError);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect retains all query cardinalities and row-count failures", (testContext) => {
  const { db, layer } = database(testContext);
  const captured = capture(layer);
  db.exec("create table numbers(n integer); insert into numbers values(1), (2)");
  assert.deepEqual(evaluate(captured(many)), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(evaluate(captured(maybe)), { n: 1 });
  assertOneRowRequired(captured);
  assertRowsAfterDeletion(db, captured);
});

const assertEncodingFailure = (): void => {
  const input = { active: true, id: 7 };
  Object.defineProperty(input, "id", { value: undefined });
  const encoded = failure(prepare(lookup, input));
  assert.ok(encoded instanceof QueryPreparationError);
  assert.ok(encoded.cause instanceof ParameterError);
};

const assertDecodingFailures = (db: DatabaseSync, captured: ReturnType<typeof capture>): void => {
  db.exec("update item set active = 2");
  const badBoolean = defineQuery<EmptyParameters, { active: boolean }, "many", "sqlite">({ cardinality: "many", columns: [["active", "bool"]], dialect: "sqlite", params: [], sql: "select active from item" });
  const decoded = failure(captured(badBoolean));
  assert.ok(decoded instanceof QueryDecodeError);
  assert.ok(decoded.cause instanceof DecodeError);
  db.exec("update item set doc = '{bad json'");
  const badJson = defineQuery<EmptyParameters, { doc: unknown }, "one", "sqlite">({ cardinality: "one", columns: [["doc", "json"]], dialect: "sqlite", params: [], sql: "select doc from item" });
  assert.ok(failure(captured(badJson)) instanceof QueryDecodeError);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect classifies encoding, decoding, and database failures with original causes", (testContext) => {
  const { db, layer } = database(testContext);
  const captured = capture(layer);
  seed(db, "first");
  assertEncodingFailure();
  assertDecodingFailures(db, captured);
  db.exec("drop table item");
  const executed = failure(captured(lookup, { active: true, id: 7 }));
  assert.ok(executed instanceof QueryExecutionError);
  assert.ok(Predicate.isError(executed.cause));
  assert.match(executed.cause.message, /no such table/u);
});
