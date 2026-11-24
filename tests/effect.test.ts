// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from 'node:sqlite';
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import type { SQLInputValue } from 'node:sqlite';
// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from 'node:test';
// oxlint-disable-next-line rules/no-node-imports -- The Nub test runner supplies Node's TestContext and its cleanup hooks.
import type { TestContext } from 'node:test';
import { Cause, Effect, Exit, Layer, Predicate, Result } from "effect";
import { defineQuery } from "@totto2727/reylo";
import { makeQueryRunner, prepare, QueryDecodeError, QueryExecutionError, QueryExecutor, QueryPreparationError, run } from '@totto2727/reylo/effect';
import type { BoundQuery } from '@totto2727/reylo/effect';
import { DecodeError, ParameterError } from "#reylo-source/values.ts";

type NoInputs = Record<never, never>;

const binding = function (value: unknown): SQLInputValue {
  if (Predicate.isNull(value) || Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBigInt(value) || value instanceof Uint8Array) {
    return value;
  }
  throw new TypeError("Unsupported SQLite binding");
};

const database = function (testContext: TestContext): { db: DatabaseSync; layer: Layer.Layer<QueryExecutor> } {
  const db = new DatabaseSync(":memory:");
  testContext.after(() => {db.close();});
  const layer = Layer.succeed(QueryExecutor, {
    dialect: "sqlite",
    execute: ({ text, values }) => Effect.try({
      try: () => {
        const statement = db.prepare(text);
        statement.setReadBigInts(true);
        return statement.all(...values.map((value) => binding(value)));
      },
      catch: (cause) => new QueryExecutionError({ cause }),
    }),
  });
  return { db, layer };
};

const lookup = defineQuery<{ id: number; active: boolean }, { id: number; active: boolean; big: bigint; doc: { name: string } }, "one", "sqlite">({
  dialect: "sqlite",
  sql: "select id, active, big, doc from item where active = :active and id = :id",
  params: ["id", "active"],
  text: "select id, active, big, doc from item where active = ? and id = ?",
  order: ["active", "id"],
  inputs: {
    id: { type: { kind: "scalar", name: "INTEGER" }, nullable: false },
    active: { type: { kind: "scalar", name: "BOOLEAN" }, nullable: false },
  },
  columns: [["id", "int"], ["active", "bool"], ["big", "int8"], ["doc", "json"]],
  cardinality: "one",
});

const seed = function (db: DatabaseSync, name: string): void {
  db.exec("create table item(id integer primary key, active boolean, big bigint, doc json)");
  db.prepare("insert into item values(?, ?, ?, ?)").run(7, 1, BigInt("9007199254740993"), JSON.stringify({ name }));
};

const failure = function <A, E>(effect: Effect.Effect<A, E>): E {
  const exit = Effect.runSyncExit(effect);
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findError(exit.cause);
  assert.ok(Result.isSuccess(error), "Expected a typed failure");
  return error.success;
};

Iterator.from([
  [QueryPreparationError, "Failed to prepare the query", "QueryPreparationError"],
  [QueryExecutionError, "Failed to execute the query", "QueryExecutionError"],
  [QueryDecodeError, "Failed to decode the query result", "QueryDecodeError"],
] as const).forEach(([ErrorType, message, tag]) => {
  // oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
  test(`${ErrorType.name} supports direct Effect failure and tagged recovery`, () => {
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
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test independently evaluates tagged error recovery.
    const original = Effect.runSync(recovered);
    assert.equal(original, cause);
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect prepares lazily, reorders and encodes inputs without executing", (testContext) => {
  const { db } = database(testContext);
  seed(db, "first");
  const input = { id: 0, active: true };
  const effect = prepare(lookup, input);
  input.id = 7;
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test evaluates preparation separately from database execution.
  const bound = Effect.runSync(effect);
  assert.equal(bound.dialect, "sqlite");
  assert.equal(bound.text, lookup["~standard"].query.text);
  assert.deepEqual(bound.values, [1, 7]);
  const statement = db.prepare(bound.text);
  statement.setReadBigInts(true);
  assert.deepEqual(statement.all(...bound.values.map(binding)).map((row) => row.id), [BigInt("7")]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect decodes object rows and runs one query through independent layers", (testContext) => {
  const first = database(testContext);
  const second = database(testContext);
  seed(first.db, "first");
  seed(second.db, "second");
  const effect = run(lookup, { id: 7, active: true });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test evaluates the query against its first independent executor.
  assert.deepEqual(Effect.runSync(Effect.provide(effect, first.layer)), { id: 7, active: true, big: BigInt("9007199254740993"), doc: { name: "first" } });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test evaluates the query against its second independent executor.
  assert.deepEqual(Effect.runSync(Effect.provide(effect, second.layer)), { id: 7, active: true, big: BigInt("9007199254740993"), doc: { name: "second" } });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("captured runner uses its construction executor with absent or conflicting context", (testContext) => {
  const first = database(testContext);
  const second = database(testContext);
  seed(first.db, "first");
  seed(second.db, "second");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test constructs a runner in a separate executor scope.
  const captured = Effect.runSync(Effect.provide(makeQueryRunner, first.layer));
  const effect = captured(lookup, { id: 7, active: true });
  const expected = { id: 7, active: true, big: BigInt("9007199254740993"), doc: { name: "first" } };
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test evaluates the captured runner without a caller-supplied executor.
  assert.deepEqual(Effect.runSync(effect), expected);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test checks that a second scope cannot replace the captured executor.
  assert.deepEqual(Effect.runSync(Effect.provide(effect, second.layer)), expected);
  first.db.exec("update item set doc = '{bad json'");
  const decoded = failure(effect);
  assert.ok(decoded instanceof QueryDecodeError);
  assert.ok(decoded.cause instanceof SyntaxError);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect retains all query cardinalities and row-count failures", (testContext) => {
  const { db, layer } = database(testContext);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test constructs a runner before checking its query cardinalities.
  const run = Effect.runSync(Effect.provide(makeQueryRunner, layer));
  db.exec("create table numbers(n integer); insert into numbers values(1), (2)");
  const many = defineQuery<NoInputs, { n: number }, "many", "sqlite">({ dialect: "sqlite", sql: "select n from numbers", params: [], columns: [["n", "int"]], cardinality: "many" });
  const one = defineQuery<NoInputs, { n: number }, "one", "sqlite">({ dialect: "sqlite", sql: "select n from numbers", params: [], columns: [["n", "int"]], cardinality: "one" });
  const maybe = defineQuery<NoInputs, { n: number }, "maybeOne", "sqlite">({ dialect: "sqlite", sql: "select n from numbers where n = 1", params: [], columns: [["n", "int"]], cardinality: "maybeOne" });
  const none = defineQuery<NoInputs, never, "none", "sqlite">({ dialect: "sqlite", sql: "delete from numbers", params: [], columns: [], cardinality: "none" });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test independently checks the many-row result.
  assert.deepEqual(Effect.runSync(Effect.provide(run(many), layer)), [{ n: 1 }, { n: 2 }]);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test independently checks the optional-row result.
  assert.deepEqual(Effect.runSync(Effect.provide(run(maybe), layer)), { n: 1 });
  const error = failure(Effect.provide(run(one), layer));
  assert.ok(error instanceof QueryDecodeError);
  assert.ok(error.cause instanceof Error);
  assert.match(error.cause.message, /Expected exactly one row, got 2/u);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test independently checks the no-result statement.
  assert.equal(Effect.runSync(Effect.provide(run(none), layer)), undefined);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test independently checks the missing optional row.
  assert.equal(Effect.runSync(Effect.provide(run(maybe), layer)), null);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test independently checks the empty many-row result.
  assert.deepEqual(Effect.runSync(Effect.provide(run(many), layer)), []);
  assert.ok(failure(Effect.provide(run(one), layer)) instanceof QueryDecodeError);
  db.exec("insert into numbers values(1), (1)");
  assert.ok(failure(Effect.provide(run(maybe), layer)) instanceof QueryDecodeError);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect classifies encoding, decoding, and database failures with original causes", (testContext) => {
  const { db, layer } = database(testContext);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test constructs a runner before checking its failure cases.
  const run = Effect.runSync(Effect.provide(makeQueryRunner, layer));
  seed(db, "first");
  const input = { id: 7, active: true };
  Object.defineProperty(input, "id", { value: undefined });
  const encoded = failure(prepare(lookup, input));
  assert.ok(encoded instanceof QueryPreparationError);
  assert.ok(encoded.cause instanceof ParameterError);
  db.exec("update item set active = 2");
  const badBoolean = defineQuery<NoInputs, { active: boolean }, "many", "sqlite">({ dialect: "sqlite", sql: "select active from item", params: [], columns: [["active", "bool"]], cardinality: "many" });
  const decoded = failure(Effect.provide(run(badBoolean), layer));
  assert.ok(decoded instanceof QueryDecodeError);
  assert.ok(decoded.cause instanceof DecodeError);
  db.exec("update item set doc = '{bad json'");
  const badJson = defineQuery<NoInputs, { doc: unknown }, "one", "sqlite">({ dialect: "sqlite", sql: "select doc from item", params: [], columns: [["doc", "json"]], cardinality: "one" });
  assert.ok(failure(Effect.provide(run(badJson), layer)) instanceof QueryDecodeError);
  db.exec("drop table item");
  const executed = failure(Effect.provide(run(lookup, { id: 7, active: true }), layer));
  assert.ok(executed instanceof QueryExecutionError);
  assert.ok(executed.cause instanceof Error);
  assert.match(executed.cause.message, /no such table/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect preserves execution failures, defects, and interruptions without remapping", () => {
  const cause = new Error("original driver failure");
  const original = new QueryExecutionError({ cause });
  const failed = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.fail(original) });
  const error = failure(Effect.provide(run(lookup, { id: 7, active: true }), failed));
  assert.equal(error, original);
  assert.equal(error.cause, cause);
  const interrupted = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.interrupt });
  const exit = Effect.runSyncExit(Effect.provide(run(lookup, { id: 7, active: true }), interrupted));
  assert.ok(Exit.hasInterrupts(exit));
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
  const defect = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.die(cause) });
  const defectExit = Effect.runSyncExit(Effect.provide(run(lookup, { id: 7, active: true }), defect));
  assert.ok(Exit.isFailure(defectExit));
  assert.equal(Cause.squash(defectExit.cause), cause);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("captured runner preserves execution causes and validates dialect before execution", () => {
  const cause = new Error("original captured driver failure");
  const original = new QueryExecutionError({ cause });
  let calls = 0;
  const executor = { dialect: "sqlite" as const, execute: () => { calls++; return Effect.fail(original); } };
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test captures the executor before testing independent failures.
  const captured = Effect.runSync(Effect.provide(makeQueryRunner, Layer.succeed(QueryExecutor, executor)));
  assert.equal(failure(captured(lookup, { id: 7, active: true })), original);
  assert.equal(original.cause, cause);
  const foreign = defineQuery<NoInputs, { n: number }, "one", "postgres">({ dialect: "postgres", sql: "select 1 as n", params: [], columns: [["n", "int"]], cardinality: "one" });
  const foreignError = failure(captured(foreign));
  assert.ok(foreignError instanceof QueryPreparationError);
  assert.ok(foreignError.cause instanceof TypeError);
  Object.defineProperty(executor, "dialect", { value: "other" });
  const mismatch = failure(captured(lookup, { id: 7, active: true }));
  assert.ok(mismatch instanceof QueryPreparationError);
  assert.ok(mismatch.cause instanceof TypeError);
  assert.equal(calls, 1);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect refuses non-SQLite queries and mismatched executors before execution", () => {
  let calls = 0;
  const executor = {
    dialect: "sqlite" as const,
    execute: () => { calls++; return Effect.succeed([]); },
  };
  const layer = Layer.succeed(QueryExecutor, executor);
  const foreign = defineQuery<NoInputs, { n: number }, "one", "postgres">({ dialect: "postgres", sql: "select 1 as n", params: [], columns: [["n", "int"]], cardinality: "one" });
  assert.ok(failure(Effect.provide(run(foreign), layer)) instanceof QueryPreparationError);
  Object.defineProperty(executor, "dialect", { value: "other" });
  assert.ok(failure(Effect.provide(run(lookup, { id: 7, active: true }), layer)) instanceof QueryPreparationError);
  assert.equal(calls, 0);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Effect rejects array rows and missing query metadata without changing runtime APIs", () => {
  const arrays = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([[7, 1]]) });
  assert.ok(failure(Effect.provide(run(lookup, { id: 7, active: true }), arrays)) instanceof QueryDecodeError);
  const missing = defineQuery<NoInputs, unknown, "many", "sqlite">({ dialect: "sqlite", sql: "select 1", params: [] });
  const objects = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([{ n: 1 }]) });
  assert.ok(failure(Effect.provide(run(missing), objects)) instanceof QueryDecodeError);
  const missingColumn = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([{ id: 7 }]) });
  assert.ok(failure(Effect.provide(run(lookup, { id: 7, active: true }), missingColumn)) instanceof QueryDecodeError);
});

// Compiled by the repository typecheck, not executed. Inputs must not widen the query's inference.
const _typeContract = function (): object {
  // @ts-expect-error factory requires an executor at construction
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This type-only assertion checks that the executor requirement prevents execution.
  Effect.runSync(makeQueryRunner);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This type-only assertion checks construction with a provided executor.
  const captured = Effect.runSync(Effect.provide(makeQueryRunner, Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([]) })));
  const capturedOne: Effect.Effect<{ id: number; active: boolean; big: bigint; doc: { name: string } }, QueryPreparationError | QueryExecutionError | QueryDecodeError> = captured(lookup, { id: 7, active: true });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This type-only assertion checks that a captured runner needs no environment.
  Effect.runSync(capturedOne);
  // @ts-expect-error captured runner retains required inputs
  captured(lookup);
  // @ts-expect-error captured runner must not widen input inference
  captured(lookup, { id: "7", active: true });
  const one: Effect.Effect<{ id: number; active: boolean; big: bigint; doc: { name: string } }, QueryPreparationError | QueryExecutionError | QueryDecodeError, QueryExecutor> = run(lookup, { id: 7, active: true });
  const bound: Effect.Effect<BoundQuery<{ id: number; active: boolean; big: bigint; doc: { name: string } }>, QueryPreparationError> = prepare(lookup, { id: 7, active: true });
  const manyQuery = defineQuery<NoInputs, { n: number }, "many", "sqlite">({ dialect: "sqlite", sql: "select 1 as n", params: [], columns: [["n", "int"]], cardinality: "many" });
  const maybeQuery = defineQuery<NoInputs, { n: number }, "maybeOne", "sqlite">({ dialect: "sqlite", sql: "select 1 as n", params: [], columns: [["n", "int"]], cardinality: "maybeOne" });
  const noneQuery = defineQuery<NoInputs, never, "none", "sqlite">({ dialect: "sqlite", sql: "delete from t", params: [], columns: [], cardinality: "none" });
  const many: Effect.Effect<{ n: number }[], unknown, QueryExecutor> = run(manyQuery);
  const maybe: Effect.Effect<{ n: number } | null, unknown, QueryExecutor> = run(maybeQuery);
  const none: Effect.Effect<void, unknown, QueryExecutor> = run(noneQuery);
  const capturedMany: Effect.Effect<{ n: number }[], unknown> = captured(manyQuery);
  const capturedMaybe: Effect.Effect<{ n: number } | null, unknown> = captured(maybeQuery);
  const capturedNone: Effect.Effect<void, unknown> = captured(noneQuery);
  // @ts-expect-error captured many results are not a single row
  const wrongCapturedMany: Effect.Effect<{ n: number }, unknown> = captured(manyQuery);
  // @ts-expect-error captured maybeOne retains null
  const wrongCapturedMaybe: Effect.Effect<{ n: number }, unknown> = captured(maybeQuery);
  // @ts-expect-error many results are not a single row
  const wrongMany: Effect.Effect<{ n: number }, unknown, QueryExecutor> = run(manyQuery);
  // @ts-expect-error maybeOne retains null
  const wrongMaybe: Effect.Effect<{ n: number }, unknown, QueryExecutor> = run(maybeQuery);
  // @ts-expect-error required query parameters cannot be omitted
  run(lookup);
  // @ts-expect-error wrong input must not widen the inferred query input
  run(lookup, { id: "7", active: true });
  // @ts-expect-error prepare retains the same required input
  prepare(lookup, { id: 7 });
  // @ts-expect-error executor remains an Effect environment requirement
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This type-only assertion checks that an uncaptured query still needs an executor.
  Effect.runSync(one);
  // @ts-expect-error execution errors require their original cause
  new QueryExecutionError({});
  // @ts-expect-error preparation errors require their original cause
  new QueryPreparationError({});
  // @ts-expect-error decoding errors require their original cause
  new QueryDecodeError({});
  const requiredCauses: readonly Readonly<{ cause: unknown }>[] = [
    new QueryPreparationError({ cause: null }),
    new QueryExecutionError({ cause: null }),
    new QueryDecodeError({ cause: null }),
  ];
  return { one, bound, many, maybe, none, requiredCauses };
};
