import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { defineQuery } from "@totto2727/reylo";
import { makeQueryRunner, prepare, QueryDecodeError, QueryExecutionError, QueryExecutor, QueryPreparationError, run, type BoundQuery } from "@totto2727/reylo/effect";
import { DecodeError, ParameterError } from "../src/values.ts";

function binding(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  throw new TypeError("Unsupported SQLite binding");
}

function database(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const layer = Layer.succeed(QueryExecutor, {
    dialect: "sqlite",
    execute: ({ text, values }) => Effect.try({
      try: () => {
        const statement = db.prepare(text);
        statement.setReadBigInts(true);
        return statement.all(...values.map(binding));
      },
      catch: (cause) => new QueryExecutionError({ cause }),
    }),
  });
  return { db, layer };
}

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

function seed(db: DatabaseSync, name: string) {
  db.exec("create table item(id integer primary key, active boolean, big bigint, doc json)");
  db.prepare("insert into item values(?, ?, ?, ?)").run(7, 1, 9007199254740993n, JSON.stringify({ name }));
}

function failure<A, E>(effect: Effect.Effect<A, E>): E {
  const exit = Effect.runSyncExit(effect);
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findError(exit.cause);
  assert.equal(error._tag, "Success");
  if (error._tag !== "Success") throw new Error("Expected a typed failure");
  return error.success;
}

test("Effect prepares lazily, reorders and encodes inputs without executing", (t) => {
  const { db } = database(t);
  seed(db, "first");
  const input = { id: 0, active: true };
  const effect = prepare(lookup, input);
  input.id = 7;
  const bound = Effect.runSync(effect);
  assert.equal(bound.dialect, "sqlite");
  assert.equal(bound.text, lookup["~standard"].query.text);
  assert.deepEqual(bound.values, [1, 7]);
  const statement = db.prepare(bound.text);
  statement.setReadBigInts(true);
  assert.deepEqual(statement.all(...bound.values.map(binding)).map((row) => row.id), [7n]);
});

test("Effect decodes object rows and runs one query through independent layers", (t) => {
  const first = database(t);
  const second = database(t);
  seed(first.db, "first");
  seed(second.db, "second");
  const effect = run(lookup, { id: 7, active: true });
  assert.deepEqual(Effect.runSync(Effect.provide(effect, first.layer)), { id: 7, active: true, big: 9007199254740993n, doc: { name: "first" } });
  assert.deepEqual(Effect.runSync(Effect.provide(effect, second.layer)), { id: 7, active: true, big: 9007199254740993n, doc: { name: "second" } });
});

test("captured runner uses its construction executor with absent or conflicting context", (t) => {
  const first = database(t);
  const second = database(t);
  seed(first.db, "first");
  seed(second.db, "second");
  const captured = Effect.runSync(Effect.provide(makeQueryRunner, first.layer));
  const effect = captured(lookup, { id: 7, active: true });
  const expected = { id: 7, active: true, big: 9007199254740993n, doc: { name: "first" } };
  assert.deepEqual(Effect.runSync(effect), expected);
  assert.deepEqual(Effect.runSync(Effect.provide(effect, second.layer)), expected);
  first.db.exec("update item set doc = '{bad json'");
  const decoded = failure(effect);
  assert.ok(decoded instanceof QueryDecodeError);
  assert.ok(decoded.cause instanceof SyntaxError);
});

test("Effect retains all query cardinalities and row-count failures", (t) => {
  const { db, layer } = database(t);
  const run = Effect.runSync(Effect.provide(makeQueryRunner, layer));
  db.exec("create table numbers(n integer); insert into numbers values(1), (2)");
  const many = defineQuery<{}, { n: number }, "many", "sqlite">({ dialect: "sqlite", sql: "select n from numbers", params: [], columns: [["n", "int"]], cardinality: "many" });
  const one = defineQuery<{}, { n: number }, "one", "sqlite">({ dialect: "sqlite", sql: "select n from numbers", params: [], columns: [["n", "int"]], cardinality: "one" });
  const maybe = defineQuery<{}, { n: number }, "maybeOne", "sqlite">({ dialect: "sqlite", sql: "select n from numbers where n = 1", params: [], columns: [["n", "int"]], cardinality: "maybeOne" });
  const none = defineQuery<{}, never, "none", "sqlite">({ dialect: "sqlite", sql: "delete from numbers", params: [], columns: [], cardinality: "none" });
  assert.deepEqual(Effect.runSync(Effect.provide(run(many), layer)), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(Effect.runSync(Effect.provide(run(maybe), layer)), { n: 1 });
  const error = failure(Effect.provide(run(one), layer));
  assert.ok(error instanceof QueryDecodeError);
  assert.ok(error.cause instanceof Error);
  assert.match(error.cause.message, /Expected exactly one row, got 2/);
  assert.equal(Effect.runSync(Effect.provide(run(none), layer)), undefined);
  assert.equal(Effect.runSync(Effect.provide(run(maybe), layer)), null);
  assert.deepEqual(Effect.runSync(Effect.provide(run(many), layer)), []);
  assert.ok(failure(Effect.provide(run(one), layer)) instanceof QueryDecodeError);
  db.exec("insert into numbers values(1), (1)");
  assert.ok(failure(Effect.provide(run(maybe), layer)) instanceof QueryDecodeError);
});

test("Effect classifies encoding, decoding, and database failures with original causes", (t) => {
  const { db, layer } = database(t);
  const run = Effect.runSync(Effect.provide(makeQueryRunner, layer));
  seed(db, "first");
  const input = { id: 7, active: true };
  Object.defineProperty(input, "id", { value: undefined });
  const encoded = failure(prepare(lookup, input));
  assert.ok(encoded instanceof QueryPreparationError);
  assert.ok(encoded.cause instanceof ParameterError);
  db.exec("update item set active = 2");
  const badBoolean = defineQuery<{}, { active: boolean }, "many", "sqlite">({ dialect: "sqlite", sql: "select active from item", params: [], columns: [["active", "bool"]], cardinality: "many" });
  const decoded = failure(Effect.provide(run(badBoolean), layer));
  assert.ok(decoded instanceof QueryDecodeError);
  assert.ok(decoded.cause instanceof DecodeError);
  db.exec("update item set doc = '{bad json'");
  const badJson = defineQuery<{}, { doc: unknown }, "one", "sqlite">({ dialect: "sqlite", sql: "select doc from item", params: [], columns: [["doc", "json"]], cardinality: "one" });
  assert.ok(failure(Effect.provide(run(badJson), layer)) instanceof QueryDecodeError);
  db.exec("drop table item");
  const executed = failure(Effect.provide(run(lookup, { id: 7, active: true }), layer));
  assert.ok(executed instanceof QueryExecutionError);
  assert.ok(executed.cause instanceof Error);
  assert.match(executed.cause.message, /no such table/);
});

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

test("captured runner preserves execution causes and validates dialect before execution", () => {
  const cause = new Error("original captured driver failure");
  const original = new QueryExecutionError({ cause });
  let calls = 0;
  const executor = { dialect: "sqlite" as const, execute: () => { calls++; return Effect.fail(original); } };
  const captured = Effect.runSync(Effect.provide(makeQueryRunner, Layer.succeed(QueryExecutor, executor)));
  assert.equal(failure(captured(lookup, { id: 7, active: true })), original);
  assert.equal(original.cause, cause);
  const foreign = defineQuery<{}, { n: number }, "one", "postgres">({ dialect: "postgres", sql: "select 1 as n", params: [], columns: [["n", "int"]], cardinality: "one" });
  const foreignError = failure(captured(foreign));
  assert.ok(foreignError instanceof QueryPreparationError);
  assert.ok(foreignError.cause instanceof TypeError);
  Object.defineProperty(executor, "dialect", { value: "other" });
  const mismatch = failure(captured(lookup, { id: 7, active: true }));
  assert.ok(mismatch instanceof QueryPreparationError);
  assert.ok(mismatch.cause instanceof TypeError);
  assert.equal(calls, 1);
});

test("Effect refuses non-SQLite queries and mismatched executors before execution", () => {
  let calls = 0;
  const executor = {
    dialect: "sqlite" as const,
    execute: () => { calls++; return Effect.succeed([]); },
  };
  const layer = Layer.succeed(QueryExecutor, executor);
  const foreign = defineQuery<{}, { n: number }, "one", "postgres">({ dialect: "postgres", sql: "select 1 as n", params: [], columns: [["n", "int"]], cardinality: "one" });
  assert.ok(failure(Effect.provide(run(foreign), layer)) instanceof QueryPreparationError);
  Object.defineProperty(executor, "dialect", { value: "other" });
  assert.ok(failure(Effect.provide(run(lookup, { id: 7, active: true }), layer)) instanceof QueryPreparationError);
  assert.equal(calls, 0);
});

test("Effect rejects array rows and missing query metadata without changing runtime APIs", () => {
  const arrays = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([[7, 1]]) });
  assert.ok(failure(Effect.provide(run(lookup, { id: 7, active: true }), arrays)) instanceof QueryDecodeError);
  const missing = defineQuery<{}, unknown, "many", "sqlite">({ dialect: "sqlite", sql: "select 1", params: [] });
  const objects = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([{ n: 1 }]) });
  assert.ok(failure(Effect.provide(run(missing), objects)) instanceof QueryDecodeError);
  const missingColumn = Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([{ id: 7 }]) });
  assert.ok(failure(Effect.provide(run(lookup, { id: 7, active: true }), missingColumn)) instanceof QueryDecodeError);
});

// Compiled by the repository typecheck, not executed. Inputs must not widen the query's inference.
function typeContract() {
  // @ts-expect-error factory requires an executor at construction
  Effect.runSync(makeQueryRunner);
  const captured = Effect.runSync(Effect.provide(makeQueryRunner, Layer.succeed(QueryExecutor, { dialect: "sqlite", execute: () => Effect.succeed([]) })));
  const capturedOne: Effect.Effect<{ id: number; active: boolean; big: bigint; doc: { name: string } }, QueryPreparationError | QueryExecutionError | QueryDecodeError> = captured(lookup, { id: 7, active: true });
  Effect.runSync(capturedOne);
  // @ts-expect-error captured runner retains required inputs
  captured(lookup);
  // @ts-expect-error captured runner must not widen input inference
  captured(lookup, { id: "7", active: true });
  const one: Effect.Effect<{ id: number; active: boolean; big: bigint; doc: { name: string } }, QueryPreparationError | QueryExecutionError | QueryDecodeError, QueryExecutor> = run(lookup, { id: 7, active: true });
  const bound: Effect.Effect<BoundQuery<{ id: number; active: boolean; big: bigint; doc: { name: string } }>, QueryPreparationError> = prepare(lookup, { id: 7, active: true });
  const manyQuery = defineQuery<{}, { n: number }, "many", "sqlite">({ dialect: "sqlite", sql: "select 1 as n", params: [], columns: [["n", "int"]], cardinality: "many" });
  const maybeQuery = defineQuery<{}, { n: number }, "maybeOne", "sqlite">({ dialect: "sqlite", sql: "select 1 as n", params: [], columns: [["n", "int"]], cardinality: "maybeOne" });
  const noneQuery = defineQuery<{}, never, "none", "sqlite">({ dialect: "sqlite", sql: "delete from t", params: [], columns: [], cardinality: "none" });
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
  Effect.runSync(one);
  // @ts-expect-error execution errors require their original cause
  new QueryExecutionError({});
  const requiredCauses: ReadonlyArray<{ readonly cause: unknown }> = [
    new QueryPreparationError({ cause: null }),
    new QueryExecutionError({ cause: null }),
    new QueryDecodeError({ cause: null }),
  ];
  return { one, bound, many, maybe, none, requiredCauses };
}
