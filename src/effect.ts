// oxlint-disable-next-line eslint/max-classes-per-file -- The query effect entry point exports its executor and the three phase-specific errors.
import { Context, Data, Effect } from "effect";
import type { ParamsArg, StandardQueryV1 } from "./index.ts";
import { objectDecoder } from "./query-metadata.ts";

/** An encoded SQL statement, independent of any database client. */
export interface SqlStatement {
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public statement type for external executors.
  readonly text: string;
  // oxlint-disable-next-line rules/no-readonly -- Preserve the read-only parameter array exposed to external executors.
  readonly values: readonly unknown[];
}

const decodeRows = Symbol("reylo.effect.decodeRows");

/** A lazily prepared SQLite statement that retains its inferred result type. */
export interface BoundQuery<Output> extends SqlStatement {
  // oxlint-disable-next-line rules/no-readonly -- Keep the prepared query contract immutable.
  readonly dialect: "sqlite";
  // oxlint-disable-next-line rules/no-readonly -- Bind the decoder to the prepared query and accept read-only driver rows.
  readonly [decodeRows]: (rows: readonly unknown[]) => Output;
}

type ErrorCause = Readonly<{ cause: unknown }>;

export class QueryPreparationError extends Data.TaggedError("QueryPreparationError")<ErrorCause> {
  // oxlint-disable-next-line rules/no-readonly -- The public error message is immutable.
  public override readonly message = "Failed to prepare the query";
}

export class QueryExecutionError extends Data.TaggedError("QueryExecutionError")<ErrorCause> {
  // oxlint-disable-next-line rules/no-readonly -- The public error message is immutable.
  public override readonly message = "Failed to execute the query";
}

export class QueryDecodeError extends Data.TaggedError("QueryDecodeError")<ErrorCause> {
  // oxlint-disable-next-line rules/no-readonly -- The public error message is immutable.
  public override readonly message = "Failed to decode the query result";
}

type Executor = Readonly<{
  dialect: "sqlite";
  // oxlint-disable-next-line rules/no-readonly -- Existing executor implementations return read-only driver rows.
  execute: (statement: SqlStatement) => Effect.Effect<readonly unknown[], QueryExecutionError>;
}>;

/** Applications provide a layer whose executor returns object rows in SQLite storage forms. */
export class QueryExecutor extends Context.Service<QueryExecutor, Executor>()("@totto2727/reylo/QueryExecutor") {}

/**
 * Encodes a query lazily.
 * @param {StandardQueryV1<Input, Output, D>} query - The standard query to prepare.
 * @param {ParamsArg<NoInfer<Input>>} input - The parameter tuple for the query.
 * @returns {Effect.Effect<BoundQuery<Output>, QueryPreparationError>} An effect that prepares the statement without executing it.
 */
export const prepare = <Input, Output, D extends StandardQueryV1.Dialect>(
  query: StandardQueryV1<Input, Output, D>,
  ...input: ParamsArg<NoInfer<Input>>
): Effect.Effect<BoundQuery<Output>, QueryPreparationError> =>
  Effect.try({
    catch: (cause) => new QueryPreparationError({ cause }),
    try: (): BoundQuery<Output> => {
      const standard = query["~standard"].query;
      if (standard.dialect !== "sqlite") {
        // oxlint-disable-next-line rules/require-tagged-error -- Existing callers inspect the native TypeError cause.
        throw new TypeError(`Expected a SQLite query, got ${standard.dialect}.`);
      }
      const values = standard.encode(input[0]);
      return {
        [decodeRows]: objectDecoder(query),
        dialect: "sqlite",
        text: standard.text,
        values,
      };
    },
  });

const runWithExecutor = <Input, Output, D extends StandardQueryV1.Dialect>(
  executor: Context.Service.Shape<typeof QueryExecutor>,
  query: StandardQueryV1<Input, Output, D>,
  ...input: ParamsArg<NoInfer<Input>>
): Effect.Effect<Output, QueryPreparationError | QueryExecutionError | QueryDecodeError> =>
  Effect.gen(function*() {
    const statement = yield* prepare(query, ...input);
    // JavaScript consumers can provide an executor with a dialect outside the typed service contract.
    const dialect: string = executor.dialect;
    if (dialect !== statement.dialect) {
      // oxlint-disable-next-line rules/require-tagged-error -- Existing callers inspect the native TypeError cause.
      const cause = new TypeError(`Expected a ${statement.dialect} executor, got ${dialect}.`);
      return yield* Effect.fail(new QueryPreparationError({ cause }));
    }
    const rows = yield* executor.execute(statement);
    return yield* Effect.try({
      catch: (cause) => new QueryDecodeError({ cause }),
      try: () => statement[decodeRows](rows),
    });
  });

/**
 * Executes and decodes a query through the injected executor.
 * @param {StandardQueryV1<Input, Output, D>} query - The standard query to execute.
 * @param {ParamsArg<NoInfer<Input>>} input - The parameter tuple for the query.
 * @returns {Effect.Effect<Output, QueryPreparationError | QueryExecutionError | QueryDecodeError, QueryExecutor>} An effect that returns decoded results with the query cardinality.
 */
export const run = <Input, Output, D extends StandardQueryV1.Dialect>(
  query: StandardQueryV1<Input, Output, D>,
  ...input: ParamsArg<NoInfer<Input>>
): Effect.Effect<Output, QueryPreparationError | QueryExecutionError | QueryDecodeError, QueryExecutor> =>
  Effect.flatMap(QueryExecutor, (executor) => runWithExecutor(executor, query, ...input));

/** Captures the executor once when constructing an application service. */
export const makeQueryRunner = Effect.map(QueryExecutor, (executor) =>
  <Input, Output, D extends StandardQueryV1.Dialect>(
    query: StandardQueryV1<Input, Output, D>,
    ...input: ParamsArg<NoInfer<Input>>
  ): Effect.Effect<Output, QueryPreparationError | QueryExecutionError | QueryDecodeError> => runWithExecutor(executor, query, ...input),
);
