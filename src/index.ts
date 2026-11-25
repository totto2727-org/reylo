// The runtime query object behind `import query from "./file.sql"`.
// Types come from the content mapper; values come from the runtime loader.
import { compile } from './execute.ts';
import type { ClientFor, Dialect, Inputs, QueryModule, SyncClientFor } from './execute.ts';
import type { StandardJSONSchemaV1, StandardTypedV1 } from "./standard.ts";
import { standardQuery } from './standard-query.ts';
import type { StandardQueryV1 } from './standard-query.ts';
import type { Structured } from "./rows.ts";
import type { Checks } from "./checks.ts";
import type { Fresh } from "./fresh.ts";
import type { Columns } from './values.ts';
import type { QueryError } from './query-error.ts';
import { querySource, QueryRuntime, requiredSchema, runtimeParams, tryNativeResult, tryResult } from "./query-runtime.ts";

export type { ClientFor, Dialect, Inputs, MysqlClient, PostgresClient, SqliteClient, SyncClientFor } from "./execute.ts";
export type { QueryTrace } from "./trace.ts";
export type { StandardQueryV1 } from "./standard-query.ts";
export { checks } from "./checks.ts";
export type { MysqlCode, MysqlErrorFields, MysqlNarrowing, MysqlQueryError, PostgresCode, PostgresCondition, PostgresErrorFields, PostgresNarrowing, PostgresQueryError, QueryError, SqliteCode, SqliteErrorFields, SqliteNarrowing, SqliteQueryError } from "./query-error.ts";

/** How many rows a statement returns: `none` is a data-modifying statement without RETURNING. */
export type Cardinality = "many" | "one" | "maybeOne" | "none";

// oxlint-disable-next-line typescript/no-invalid-void-type -- Preserve the public no-row result as void.
export type Materialize<Row, C extends Cardinality> = C extends "many" ? Row[] : C extends "one" ? Row : C extends "none" ? void : Row | null;

/**
 * Any JSON value: what a `json` or `jsonb` value is when nothing in the schema or the statement
 * gives its shape, and what any value inside JSON a statement builds is where Reylo cannot type it.
 * A key's value may be `undefined`, which a read of a missing key gives and `JSON.stringify` leaves
 * out of a parameter.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/**
 * The shape of a row value as JSON: a BigInt is the integer it is (JSON.stringify refuses one, so a
 * serializer writes it, as `JSON.rawJSON(String(v))` does), and a Temporal value or a byte array
 * becomes text.
 */
export type AsJson<T> = T extends bigint
  ? number
  : T extends Date | Uint8Array | { toJSON: () => string }
  ? string
  : T extends Readonly<(infer U)[]>
    ? AsJson<U>[]
    : T extends object
      ? { [K in keyof T]: AsJson<T[K]> }
      : T;

export type ReyloTypes<Params, Row, C extends Cardinality> = Readonly<{
  element: Row;
  cardinality: C;
  json: Materialize<AsJson<Row>, C>;
  input: Params;
}>;

/**
 * What `try` returns: the value, or the error the database raised. The other field is undefined,
 * so either can be read first, as `if (result.error)`; the shape is Standard Schema's result, with one
 * error where it has a list of issues.
 */
export type TryResult<Value, E> = Readonly<{ value: Value; error?: undefined }> | Readonly<{ error: E; value?: undefined }>;

/** A query: its statement, its parameters and result types (`Params`, `Row`), and the error its database may raise (`E`). */
export interface Query<Params, Row, C extends Cardinality, D extends Dialect, E = QueryError<D>>
  extends StandardTypedV1<Params, Materialize<Row, C>>, StandardJSONSchemaV1<Params, Materialize<Row, C>>, StandardQueryV1<Params, Materialize<Row, C>, D> {
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Query property contract.
  readonly dialect: D;
  // `sql` and `raw` carry no doc comment: each module declares them as their own text, which a
  // Hover shows. `sql` is the base text: a structured parameter (`::rows`, `::row`, src/rows.ts) in a
  // MySQL insert has its column lists written again for the keys each call carries, and the
  // Statement Reylo sends ends with the comment naming its file, which `sql` leaves out.
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Query property contract.
  readonly sql: string;
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Query property contract.
  readonly raw: string;
  /** Parameter names in binding order. */
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Query property contract.
  readonly params: Readonly<string[]>;
  /**
   * The `.sql` file the query was built from, relative to the project's root: a name for logs and
   * traces. Reylo's own errors about the query start with it. A query defined by hand has none.
   */
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Query property contract.
  readonly source: string | undefined;
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Query property contract.
  readonly cardinality: C;
  /** The JSON Schema (2020-12) of the parameters, as the object `run` takes. */
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Query property contract.
  readonly inputSchema: Record<string, unknown>;
  /** The JSON Schema (2020-12) of the result as JSON: what `run` returns, written as JSON, a BigInt as the integer it is. */
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Query property contract.
  readonly outputSchema: Record<string, unknown>;
  /** Standard JSON Schema's `jsonSchema` and Standard Query's `query`: a driver that supports Standard Query runs the import with the same input and output as `.run()`. */
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Query property contract.
  readonly "~standard": StandardJSONSchemaV1.Props<Params, Materialize<Row, C>> & StandardQueryV1.Props<Params, Materialize<Row, C>, D>;
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Query property contract.
  readonly "~reylo": ReyloTypes<Params, Row, C>;
  /**
   * Runs the statement on the client, or on a transaction or connection taken from it. The
   * parameters are an object keyed by name (by number, `{ 1: … }`, for positional placeholders),
   * left out when the statement takes none. Always a promise, which rejects with the driver's own error.
   */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the published method signature and its variance.
  run(client: ClientFor<D>, ...params: ParamsArg<Params>): Promise<Materialize<Row, C>>;
  /**
   * Runs the statement on a synchronous SQLite client (better-sqlite3, node:sqlite, bun:sqlite)
   * and returns the result itself, throwing the driver's error, so it works inside their
   * `db.transaction(fn)`, whose function cannot await.
   */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the published method signature and its variance.
  runSync(client: SyncClientFor<D>, ...params: ParamsArg<Params>): Materialize<Row, C>;
  /**
   * Runs the statement as `run` does, and resolves to `{ value }`, or to `{ error }` where the
   * database raised an error: its code from the database's own list, and the constraint, table or
   * column it names. Every other error rejects, as from `run`: a refused connection, a client
   * Reylo cannot run on, a value Reylo refuses.
   */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the published method signature and its variance.
  try(client: ClientFor<D>, ...params: ParamsArg<Params>): Promise<TryResult<Materialize<Row, C>, E>>;
  /** `try` on a synchronous SQLite client, as `runSync`: it returns the result itself. */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the published method signature and its variance.
  trySync(client: SyncClientFor<D>, ...params: ParamsArg<Params>): TryResult<Materialize<Row, C>, E>;
  /** The statement bound to a client, such as a transaction: `const get = q.with(tx); await get({ id: 1 })`. */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the published method signature and its variance.
  with(client: ClientFor<D>): (...params: ParamsArg<Params>) => Promise<Materialize<Row, C>>;
}

/** The parameters argument, always an object: required when the statement takes any, optional when it takes none. */
// oxlint-disable-next-line typescript/ban-types, typescript/no-empty-object-type -- Any input type that permits an empty object can omit the argument.
export type ParamsArg<Params> = {} extends Params ? [params?: Params] : [params: Params];

// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve the public definition record's structural assignability.
export type QueryDefinition = {
  dialect: Dialect;
  /** The statement as written, Reylo's placeholders in place: the query's `raw`. */
  sql: string;
  params: Readonly<string[]>;
  /**
   * The statement as the engine compiled it for the database, the query's `sql`, and its binding
   * order: every build step puts them in the module. A query defined by hand without them is
   * compiled from `sql` by the run time's own lexer.
   */
  text?: string;
  order?: Readonly<string[]>;
  /** Each parameter's type, by name, as the engine found it: every build step puts it in the module, and a driver that binds some values wrong gets them converted by it. */
  inputs?: Inputs;
  /** Each output column's name and kind (src/values.ts), in order: every build step puts them in the module, and the run time gives each value its kind by them. */
  columns?: Columns;
  /** Each structured parameter in a MySQL insert, with the lists of `text` the run time writes again for the keys a call carries (a Postgres or SQLite insert copies its defaults instead). */
  structured?: Readonly<Structured[]>;
  /** The catalog facts the statement relied on, which the run time checks before it runs (src/fresh.ts). */
  fresh?: Fresh;
  /** The `.sql` file, relative to the project's root and written with `/`: the query's `source`. Every build step puts it in the module. */
  source?: string;
  /** Whether the statement Reylo sends ends with a sqlcommenter comment naming `source` (src/sqlcommenter.ts), as a build step writes unless the project file says `sqlcommenter: false`. The query's `sql` leaves it out. */
  sqlcommenter?: boolean;
  cardinality?: Cardinality;
  jsonSchema?: { input: Record<string, unknown>; output: Record<string, unknown> };
  /** The checks of a typed JSON, structured or cast parameter, `checks` from "@totto2727/reylo": a build step passes them where the statement has one, so that an app none of whose statements has one bundles none of them. */
  checks?: Checks;
};

const STANDARD_VERSION = 1;

const runtimeModule = <D extends Dialect>(definition: QueryDefinition & { dialect: D }): QueryModule<D> => (
  // oxlint-disable-next-line eslint/sort-keys -- Read a handwritten definition's bindings in their established order.
  {
    dialect: definition.dialect,
    sql: definition.sql,
    params: definition.params,
    text: definition.text,
    order: definition.order,
    inputs: definition.inputs,
    columns: definition.columns,
    structured: definition.structured,
    fresh: definition.fresh,
    source: definition.source,
    sqlcommenter: definition.sqlcommenter,
    checks: definition.checks,
  }
);

const sqlText = (module: QueryModule): (() => string) => {
  const cache: { text?: string } = {};
  return () => {
    cache.text ??= compile(module).text;
    return cache.text;
  };
};

interface QuerySettings<Row, C extends Cardinality, D extends Dialect> {
  cardinality: C;
  definition: QueryDefinition & { dialect: D };
  module: QueryModule<D>;
  runtime: QueryRuntime<D, Row, C>;
}

const queryObject = <Params, Row, C extends Cardinality, D extends Dialect>(
  { cardinality, definition, module, runtime }: QuerySettings<Row, C, D>,
): Query<Params, Row, C, D> => {
  const text = sqlText(module);
  const dialect = (): D => definition.dialect;
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the published query object's enumerable property order.
  const query: Query<Params, Row, C, D> = {
    dialect: definition.dialect,
    get sql() {return text();},
    raw: definition.sql,
    params: definition.params,
    source: definition.source,
    cardinality,
    get inputSchema() {return requiredSchema(definition, "input");},
    get outputSchema() {return requiredSchema(definition, "output");},
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the Standard Schema and Standard Query descriptor's published key order.
    "~standard": {
      version: STANDARD_VERSION,
      vendor: "reylo",
      jsonSchema: {
        input: () => requiredSchema(definition, "input"),
        output: () => requiredSchema(definition, "output"),
      },
      query: standardQuery(module, (rows) => runtime.materialize(rows)),
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This published property exists for type inference and has no runtime witness.
    "~reylo": undefined as unknown as ReyloTypes<Params, Row, C>,
    // oxlint-disable-next-line typescript/promise-function-async -- Keep the native execution Promise returned through the public method.
    run: (client: ClientFor<D>, params?: Params) => runtime.run(client, runtimeParams(params)),
    runSync: (client: SyncClientFor<D>, params?: Params) => runtime.runNative(client, runtimeParams(params)),
    // oxlint-disable-next-line typescript/promise-function-async -- Keep the original Promise chain for the driver error conversion.
    try: (client: ClientFor<D>, params?: Params) => tryResult(runtime.run(client, runtimeParams(params)), dialect),
    trySync: (client: SyncClientFor<D>, params?: Params) => tryNativeResult(
      // oxlint-disable-next-line rules/no-effect-runtime-run, typescript/no-unsafe-type-assertion -- This is Reylo's public native SQLite method and forwards its original parameter tuple.
      () => query.runSync(client, ...([params] as ParamsArg<Params>)),
      dialect,
    ),
    // oxlint-disable-next-line typescript/promise-function-async -- The client-bound function returns the same native execution Promise as run().
    with: (client: ClientFor<D>) => (params?: Params) => runtime.run(client, runtimeParams(params)),
  };
  return query;
};

/**
 * Construct a typed query from its generated or handwritten definition.
 * @template Params, Row, C, D
 * @param {QueryDefinition & { dialect: D; cardinality?: C }} definition - The statement and its analyzed bindings.
 * @returns {Query<Params, Row, C, D>} The typed runtime query.
 */
export const defineQuery = function defineQuery<Params, Row, C extends Cardinality, D extends Dialect>(
  definition: QueryDefinition & { dialect: D; cardinality?: C },
): Query<Params, Row, C, D> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- An omitted cardinality follows the public API's historical many default.
  const cardinality = (definition.cardinality ?? "many") as C;
  const where = querySource(definition.source);
  const module = runtimeModule(definition);
  const runtime = new QueryRuntime<D, Row, C>({ cardinality, module, where });
  const query = queryObject<Params, Row, C, D>({ cardinality, definition, module, runtime });
  runtime.bind(query);
  return query;
};
