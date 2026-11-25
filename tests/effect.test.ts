// oxlint-disable-next-line rules/no-node-imports -- Nub compares actual results and error identities through Node's assertions.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Register these integration cases with Nub's native Node test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Execute the prepared parameters through the real SQLite driver.
import type { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { prepare, QueryDecodeError, run } from "@totto2727/reylo/effect";
import type { BoundQuery } from "@totto2727/reylo/effect";
import { binding, capture, database, evaluate, failure, lookup, seed } from "./effect-query-fixture.ts";
import type { LookupRow } from "./effect-query-fixture.ts";

const assertBoundStatement = (db: DatabaseSync, bound: BoundQuery<LookupRow>): void => {
  const statement = db.prepare(bound.text);
  statement.setReadBigInts(true);
  assert.deepEqual(statement.all(...bound.values.map(binding)).map((row) => row.id), [BigInt("7")]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect prepares lazily, reorders and encodes inputs without executing", (testContext) => {
  const { db } = database(testContext);
  seed(db, "first");
  const input = { active: true, id: 0 };
  const effect = prepare(lookup, input);
  input.id = 7;
  const bound = evaluate(effect);
  assert.equal(bound.dialect, "sqlite");
  assert.equal(bound.text, lookup["~standard"].query.text);
  assert.deepEqual(bound.values, [1, 7]);
  assertBoundStatement(db, bound);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect decodes object rows and runs one query through independent layers", (testContext) => {
  const first = database(testContext);
  const second = database(testContext);
  seed(first.db, "first");
  seed(second.db, "second");
  const effect = run(lookup, { active: true, id: 7 });
  assert.deepEqual(evaluate(Effect.provide(effect, first.layer)), { active: true, big: BigInt("9007199254740993"), doc: { name: "first" }, id: 7 });
  assert.deepEqual(evaluate(Effect.provide(effect, second.layer)), { active: true, big: BigInt("9007199254740993"), doc: { name: "second" }, id: 7 });
});

const assertCapturedDecodeFailure = (
  db: DatabaseSync,
  effect: ReturnType<ReturnType<typeof capture>>,
): void => {
  db.exec("update item set doc = '{bad json'");
  const decoded = failure(effect);
  assert.ok(decoded instanceof QueryDecodeError);
  assert.ok(decoded.cause instanceof SyntaxError);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("captured runner uses its construction executor with absent or conflicting context", (testContext) => {
  const first = database(testContext);
  const second = database(testContext);
  seed(first.db, "first");
  seed(second.db, "second");
  const captured = capture(first.layer);
  const effect = captured(lookup, { active: true, id: 7 });
  const expected = { active: true, big: BigInt("9007199254740993"), doc: { name: "first" }, id: 7 };
  assert.deepEqual(evaluate(effect), expected);
  assert.deepEqual(evaluate(Effect.provide(effect, second.layer)), expected);
  assertCapturedDecodeFailure(first.db, effect);
});
