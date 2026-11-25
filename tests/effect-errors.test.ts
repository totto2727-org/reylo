// oxlint-disable-next-line rules/no-node-imports -- Nub compares actual results and error identities through Node's assertions.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Register these integration cases with Nub's native Node test runner.
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Predicate } from "effect";
import { defineQuery } from "@totto2727/reylo";
import { QueryDecodeError, QueryExecutionError, QueryExecutor, QueryPreparationError, run } from "@totto2727/reylo/effect";
import type { Context } from "effect";
import { capture, evaluate, failure, lookup } from "./effect-query-fixture.ts";
import type { EmptyParameters } from "./helpers.ts";

const INPUT = { active: true, id: 7 };
const FOREIGN = defineQuery<EmptyParameters, { n: number }, "one", "postgres">({
  cardinality: "one", columns: [["n", "int"]], dialect: "postgres", params: [], sql: "select 1 as n",
});
const LOOKUP = run(lookup, INPUT);

Iterator.from([
  [QueryPreparationError, "Failed to prepare the query", "QueryPreparationError"],
  [QueryExecutionError, "Failed to execute the query", "QueryExecutionError"],
  [QueryDecodeError, "Failed to decode the query result", "QueryDecodeError"],
] as const).forEach(([ErrorType, message, tag]) => {
  // oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
  test(`${ErrorType.name} supports direct Effect failure and tagged recovery`, () => {
    // oxlint-disable-next-line rules/require-tagged-error -- Recovery must return the same untagged native cause supplied by the caller.
    const cause = new Error("original query failure");
    const error = new ErrorType({ cause });
    const program = Effect.gen(function*() {
      return yield* error;
    });
    assert.equal(failure(program), error);
    assert.equal(error.cause, cause);
    assert.equal(error.message, message);
    assert.ok(Predicate.isError(error));
    const recovered = program.pipe(Effect.catchTag(tag, (matched) => Effect.succeed(matched.cause)));
    const original = evaluate(recovered);
    assert.equal(original, cause);
  });
});

const assertInterrupted = (): void => {
  const interrupted = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.interrupt });
  const exit = Effect.runSyncExit(Effect.provide(LOOKUP, interrupted));
  assert.ok(Exit.hasInterrupts(exit));
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
};

const assertDefectIdentity = (cause: Error): void => {
  const defect = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.die(cause) });
  const defectExit = Effect.runSyncExit(Effect.provide(LOOKUP, defect));
  assert.ok(Exit.isFailure(defectExit));
  assert.equal(Cause.squash(defectExit.cause), cause);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect preserves execution failures, defects, and interruptions without remapping", () => {
  // oxlint-disable-next-line rules/require-tagged-error -- A native driver failure or defect must preserve this original untagged cause.
  const cause = new Error("original driver failure");
  const original = new QueryExecutionError({ cause });
  const failed = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.fail(original) });
  const error = failure(Effect.provide(LOOKUP, failed));
  assert.equal(error, original);
  assert.equal(error.cause, cause);
  assertInterrupted();
  assertDefectIdentity(cause);
});

const assertRejectedDialects = (
  captured: ReturnType<typeof capture>,
  executor: Context.Service.Shape<typeof QueryExecutor>,
): void => {
  const foreignError = failure(captured(FOREIGN));
  assert.ok(foreignError instanceof QueryPreparationError);
  assert.ok(foreignError.cause instanceof TypeError);
  Object.defineProperty(executor, "dialect", { value: "other" });
  const mismatch = failure(captured(lookup, INPUT));
  assert.ok(mismatch instanceof QueryPreparationError);
  assert.ok(mismatch.cause instanceof TypeError);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("captured runner preserves execution causes and validates dialect before execution", (testContext) => {
  // oxlint-disable-next-line rules/require-tagged-error -- A captured runner must preserve the original untagged driver cause.
  const cause = new Error("original captured driver failure");
  const original = new QueryExecutionError({ cause });
  const execute = testContext.mock.fn(() => Effect.fail(original));
  const executor = { dialect: "sqlite" as const, execute };
  const captured = capture(Layer.succeed(QueryExecutor, executor));
  assert.equal(failure(captured(lookup, INPUT)), original);
  assert.equal(original.cause, cause);
  assertRejectedDialects(captured, executor);
  assert.equal(execute.mock.callCount(), 1);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect refuses non-SQLite queries and mismatched executors before execution", (testContext) => {
  const execute = testContext.mock.fn(() => Effect.succeed([]));
  const executor = { dialect: "sqlite" as const, execute };
  const layer = Layer.succeed(QueryExecutor, executor);
  const foreign = run(FOREIGN);
  assert.ok(failure(Effect.provide(foreign, layer)) instanceof QueryPreparationError);
  Object.defineProperty(executor, "dialect", { value: "other" });
  assert.ok(failure(Effect.provide(LOOKUP, layer)) instanceof QueryPreparationError);
  assert.equal(execute.mock.callCount(), 0);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect rejects array rows and missing query metadata without changing runtime APIs", () => {
  const arrays = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([[7, 1]]) });
  assert.ok(failure(Effect.provide(LOOKUP, arrays)) instanceof QueryDecodeError);
  const missing = defineQuery<EmptyParameters, unknown, "many", "sqlite">({ dialect: "sqlite", params: [], sql: "select 1" });
  const objects = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([{ n: 1 }]) });
  const undefinedMetadata = run(missing);
  assert.ok(failure(Effect.provide(undefinedMetadata, objects)) instanceof QueryDecodeError);
  const missingColumn = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([{ id: 7 }]) });
  assert.ok(failure(Effect.provide(LOOKUP, missingColumn)) instanceof QueryDecodeError);
});
