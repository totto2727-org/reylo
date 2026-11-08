import { Context, Effect } from "effect";
import type { ParamsArg, StandardQueryV1 } from "./index.ts";
import { objectDecoder } from "./query-metadata.ts";

/** An encoded SQL statement, independent of any database client. */
export interface SqlStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

const decodeRows = Symbol("reylo.effect.decodeRows");

/** A lazily prepared SQLite statement that retains its inferred result type. */
export interface BoundQuery<Output> extends SqlStatement {
  readonly dialect: "sqlite";
  readonly [decodeRows]: (rows: readonly unknown[]) => Output;
}

export class QueryPreparationError extends Error {
  readonly _tag = "QueryPreparationError";
  override readonly cause: unknown;
  constructor(options: { readonly cause: unknown }) {
    super("Failed to prepare the query", options);
    this.cause = options.cause;
  }
}

export class QueryExecutionError extends Error {
  readonly _tag = "QueryExecutionError";
  override readonly cause: unknown;
  constructor(options: { readonly cause: unknown }) {
    super("Failed to execute the query", options);
    this.cause = options.cause;
  }
}

export class QueryDecodeError extends Error {
  readonly _tag = "QueryDecodeError";
  override readonly cause: unknown;
  constructor(options: { readonly cause: unknown }) {
    super("Failed to decode the query result", options);
    this.cause = options.cause;
  }
}

/** Applications provide a layer whose executor returns object rows in SQLite storage forms. */
export class QueryExecutor extends Context.Service<QueryExecutor, {
  readonly dialect: "sqlite";
  readonly execute: (statement: SqlStatement) => Effect.Effect<ReadonlyArray<unknown>, QueryExecutionError>;
}>()("@totto2727/reylo/QueryExecutor") {}

/** Encodes only when evaluated. It does not access an executor or execute database work. */
export function prepare<Input, Output, D extends StandardQueryV1.Dialect>(
  query: StandardQueryV1<Input, Output, D>,
  ...input: ParamsArg<NoInfer<Input>>
): Effect.Effect<BoundQuery<Output>, QueryPreparationError> {
  return Effect.try({
    try: () => {
      const standard = query["~standard"].query;
      if (standard.dialect !== "sqlite") throw new TypeError(`Expected a SQLite query, got ${standard.dialect}.`);
      const values = standard.encode(input[0]);
      return {
        dialect: "sqlite" as const,
        text: standard.text,
        values,
        [decodeRows]: objectDecoder(query),
      };
    },
    catch: (cause) => new QueryPreparationError({ cause }),
  });
}

/** Runs a query through the injected executor, then uses Reylo's decoder and cardinality. */
export function run<Input, Output, D extends StandardQueryV1.Dialect>(
  query: StandardQueryV1<Input, Output, D>,
  ...input: ParamsArg<NoInfer<Input>>
): Effect.Effect<Output, QueryPreparationError | QueryExecutionError | QueryDecodeError, QueryExecutor> {
  return Effect.gen(function*() {
    const statement = yield* prepare(query, ...input);
    const executor = yield* QueryExecutor;
    if (executor.dialect !== statement.dialect) {
      return yield* Effect.fail(new QueryPreparationError({ cause: new TypeError(`Expected a ${statement.dialect} executor, got ${executor.dialect}.`) }));
    }
    const rows = yield* executor.execute(statement);
    return yield* Effect.try({
      try: () => statement[decodeRows](rows),
      catch: (cause) => new QueryDecodeError({ cause }),
    });
  });
}
