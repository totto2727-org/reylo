// oxlint-disable-next-line rules/no-node-imports -- Native assertions narrow the actual synchronous effect exit.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Supply an actual SQLite database to the Effect runtime adapter.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- Supply the binding type accepted by the native SQLite statements.
import type { SQLInputValue } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- Nub's native test context owns cleanup of the fixture connection.
import type { TestContext } from "node:test";
import { Cause, Effect, Exit, Layer, Predicate, Result } from "effect";
import { defineQuery } from "@totto2727/reylo";
import { makeQueryRunner, QueryExecutionError, QueryExecutor } from "@totto2727/reylo/effect";

export const binding = function (value: unknown): SQLInputValue {
  // oxlint-disable-next-line rules/prefer-is-nullish -- SQLite accepts SQL null as a binding, while undefined is invalid.
  if (Predicate.isNull(value) || Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBigInt(value) || Predicate.isUint8Array(value)) {
    return value;
  }
  // oxlint-disable-next-line rules/require-tagged-error -- This native adapter checks the bindings it hands to node:sqlite.
  throw new TypeError("Unsupported SQLite binding");
};

export const database = function (testContext: TestContext): { db: DatabaseSync; layer: Layer.Layer<QueryExecutor> } {
  const db = new DatabaseSync(":memory:");
  testContext.after(() => {db.close();});
  const layer = Layer.succeed(QueryExecutor, {
    dialect: "sqlite",
    execute: ({ text, values }) => Effect.try({
      catch: (cause) => new QueryExecutionError({ cause }),
      try: () => {
        const statement = db.prepare(text);
        statement.setReadBigInts(true);
        return statement.all(...values.map((value) => binding(value)));
      },
    }),
  });
  return { db, layer };
};

export interface LookupInput { active: boolean; id: number }
export interface LookupRow extends LookupInput { big: bigint; doc: { name: string } }

export const lookup = defineQuery<LookupInput, LookupRow, "one", "sqlite">({
  cardinality: "one",
  columns: [["id", "int"], ["active", "bool"], ["big", "int8"], ["doc", "json"]],
  dialect: "sqlite",
  inputs: {
    active: { nullable: false, type: { kind: "scalar", name: "BOOLEAN" } },
    id: { nullable: false, type: { kind: "scalar", name: "INTEGER" } },
  },
  order: ["active", "id"],
  params: ["id", "active"],
  sql: "select id, active, big, doc from item where active = :active and id = :id",
  text: "select id, active, big, doc from item where active = ? and id = ?",
});

const SEEDED_ID = 7;
const SQLITE_TRUE = 1;

export const seed = function (db: DatabaseSync, name: string): void {
  db.exec("create table item(id integer primary key, active boolean, big bigint, doc json)");
  db.prepare("insert into item values(?, ?, ?, ?)").run(SEEDED_ID, SQLITE_TRUE, BigInt("9007199254740993"), JSON.stringify({ name }));
};

export const failure = function <Value, Failure>(effect: Effect.Effect<Value, Failure>): Failure {
  const exit = Effect.runSyncExit(effect);
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findError(exit.cause);
  assert.ok(Result.isSuccess(error), "Expected a typed failure");
  return error.success;
};

export const capture = (layer: Layer.Layer<QueryExecutor>): Effect.Success<typeof makeQueryRunner> =>
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This fixture captures an executor in a separate runtime scope from the caller's query.
  Effect.runSync(Effect.provide(makeQueryRunner, layer));

export const evaluate = <Value, Failure>(effect: Effect.Effect<Value, Failure>): Value =>
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Nub owns the synchronous test lifecycle and needs the result of this independent Effect execution.
  Effect.runSync(effect);
