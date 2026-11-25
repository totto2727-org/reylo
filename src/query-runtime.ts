import { normalize } from "./decode-sqlite.ts";
import { execute, executeSync } from "./execute.ts";
import type { ClientFor, Dialect, QueryModule, SyncClientFor } from "./execute.ts";
import type { Cardinality, Materialize, QueryDefinition, TryResult } from "./index.ts";
import { isRecord, matchesNullish, matchesString, matchesUndefined, nonemptyText } from "./native-predicates.ts";
import { readQueryError, readQueryErrorSync } from "./query-error.ts";
import type { QueryError } from "./query-error.ts";
import { registerObjectDecoder } from "./query-metadata.ts";
import type { StandardTypedV1 } from "./standard.ts";
import { listening } from "./trace.ts";
import type { QueryTrace } from "./trace.ts";
import { DecodeError, ParameterError } from "./values.ts";

type Inputs = Record<string, unknown>;
type Columns = NonNullable<QueryModule["columns"]>;
const ONE_ROW = 1;
const FIRST_ROW = 0;

const singleValue = (rows: unknown[], required: boolean, where: string): unknown => {
  if (required) {
    if (rows.length !== ONE_ROW) {
      // oxlint-disable-next-line rules/require-tagged-error -- A query's native cardinality error is shared by all runtimes.
      throw new Error(`${where}Expected exactly one row, got ${rows.length}`);
    }
    return rows[FIRST_ROW];
  }
  if (rows.length > ONE_ROW) {
    // oxlint-disable-next-line rules/require-tagged-error -- A query's native cardinality error is shared by all runtimes.
    throw new Error(`${where}Expected at most one row, got ${rows.length}`);
  }
  // oxlint-disable-next-line unicorn/no-null -- The public maybeOne result uses SQL NULL for an absent row.
  return rows[FIRST_ROW] ?? null;
};

const cardinalityValue = (rows: unknown[], cardinality: Cardinality, where: string): unknown => {
  if (cardinality === "none") {return undefined;}
  if (cardinality === "many") {return rows;}
  return singleValue(rows, cardinality === "one", where);
};

const named = (error: unknown, where: string | undefined): unknown => {
  if (matchesUndefined(where) || !(error instanceof ParameterError || error instanceof DecodeError)) {return error;}
  if (error.message.startsWith(where)) {return error;}
  const { message } = error;
  error.message = where + message;
  // The engine may have already captured the stack using the previous message.
  if (matchesString(error.stack) && !error.stack.includes(error.message)) {
    error.stack = error.stack.replace(message, () => error.message);
  }
  return error;
};

const copyObjectRow = (row: unknown, columns: Columns): Record<string, unknown> => {
  if (!isRecord(row)) {throw new DecodeError("Expected an object row from the query executor.");}
  Iterator.from(columns).forEach(([name]) => {
    if (!Object.hasOwn(row, name)) {throw new DecodeError(`The query executor's row is missing column "${name}".`);}
  });
  return { ...row };
};

const objectRows = (module: QueryModule, rows: Readonly<unknown[]>): unknown[] => {
  if (module.dialect !== "sqlite") {
    // oxlint-disable-next-line rules/require-tagged-error -- The object-row bridge exposes the native unsupported-dialect TypeError.
    throw new TypeError("Object-row execution supports only SQLite queries.");
  }
  const { columns } = module;
  if (matchesUndefined(columns)) {
    // oxlint-disable-next-line rules/require-tagged-error -- Handwritten queries without columns cannot decode through this bridge.
    throw new TypeError("A query defined by hand without its columns cannot map rows to its output.");
  }
  return normalize(rows.map((row) => copyObjectRow(row, columns)), columns);
};

interface Settings<D extends Dialect, C extends Cardinality> { cardinality: C; module: QueryModule<D>; where?: string | undefined }

export class QueryRuntime<D extends Dialect, Row, C extends Cardinality> {
  #settings: Settings<D, C>;
  #query: QueryTrace["query"] | undefined;

  public constructor(settings: Settings<D, C>) {this.#settings = settings;}

  public bind<Params>(query: StandardTypedV1<Params, Materialize<Row, C>>): void {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The native trace exposes every typed query for inspection through its generic contract.
    this.#query = query as QueryTrace["query"];
    registerObjectDecoder(query, (rows) => this.#decodeObjectRows(rows));
  }

  public materialize(rows: unknown[]): Materialize<Row, C> {
    const { cardinality, where } = this.#settings;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The native result uses the analyzed row type and the published cardinality.
    return cardinalityValue(rows, cardinality, where ?? "") as Materialize<Row, C>;
  }

  #decodeObjectRows(rows: Readonly<unknown[]>): Materialize<Row, C> {
    return this.materialize(objectRows(this.#settings.module, rows));
  }

  #trace(client: unknown, params: Inputs, sync: boolean): QueryTrace {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- defineQuery binds the public query before exposing any method that traces it.
    const query = this.#query!;
    // oxlint-disable-next-line eslint/sort-keys -- Keep the query tracing context's published property order.
    return { query, client, params, sync };
  }

  // oxlint-disable-next-line typescript/promise-function-async -- Preserve execution's Promise and synchronous driver behavior.
  #once(client: ClientFor<D>, params: Inputs): Promise<Materialize<Row, C>> {
    const { module, where } = this.#settings;
    try {
      const rows = execute(client, module, params);
      if (Array.isArray(rows)) {return Promise.resolve(this.materialize(rows));}
      // oxlint-disable-next-line promise/prefer-catch -- Separate driver rejections from exceptions while materializing successful rows.
      return rows.then(
        (value) => this.materialize(value),
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Prefix the native driver's rejection on its original Promise chain.
        (error: unknown) => {throw named(error, where);},
      );
    } catch (error) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- A native driver may throw any value. Reylo forwards it as the rejection reason.
      return Promise.reject(named(error, where));
    }
  }

  // oxlint-disable-next-line typescript/promise-function-async -- Return the trace or execution Promise directly to the public query.
  public run(client: ClientFor<D>, params: Inputs): Promise<Materialize<Row, C>> {
    const tracing = listening();
    if (matchesUndefined(tracing)) {return this.#once(client, params);}
    // oxlint-disable-next-line typescript/promise-function-async -- The tracing callback returns the original driver execution Promise.
    return tracing.tracePromise(() => this.#once(client, params), this.#trace(client, params, false));
  }

  public runNative(client: SyncClientFor<D>, params: Inputs): Materialize<Row, C> {
    const { module, where } = this.#settings;
    const run = (): Materialize<Row, C> => {
      try {
        // oxlint-disable-next-line node/no-sync -- The public SQLite runSync API executes inside a synchronous transaction.
        return this.materialize(executeSync(client, module, params));
      } catch (error) {
        throw named(error, where);
      }
    };
    const tracing = listening();
    // oxlint-disable-next-line node/no-sync -- Emit the same native trace before returning from the synchronous query.
    return matchesUndefined(tracing) ? run() : tracing.traceSync(run, this.#trace(client, params, true));
  }
}

export const querySource = (source: string | undefined): string | undefined => {
  const file = nonemptyText(source);
  return matchesUndefined(file) ? undefined : `${file}: `;
};

export const requiredSchema = (definition: QueryDefinition, position: "input" | "output"): Record<string, unknown> => {
  const schema = definition.jsonSchema?.[position];
  if (!matchesNullish(schema)) {return schema;}
  // oxlint-disable-next-line rules/require-tagged-error -- Native queries expose this error without installing or loading Effect.
  throw new Error("No JSON Schema is available for this query: a module a build step writes carries it, and a query defined by hand has none.");
};

export const runtimeParams = (params: unknown): Record<string, unknown> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Let native binding validate a caller's parameters, including handwritten JavaScript calls.
  (params ?? {}) as Record<string, unknown>;

type DialectFor<D extends Dialect> = () => D;

// oxlint-disable-next-line typescript/promise-function-async -- Preserve the original Promise chain and driver rejection boundary for try().
export const tryResult = <Value, D extends Dialect>(call: Promise<Value>, dialect: DialectFor<D>): Promise<TryResult<Value, QueryError<D>>> =>
  // oxlint-disable-next-line promise/prefer-await-to-then, promise/prefer-catch -- Distinguish this native call's result from its driver rejection.
  call.then(
    (value) => ({ value }),
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Keep the driver-only rejection branch in the existing execution chain.
    async (error: unknown) => {
      const read = await readQueryError(dialect(), error);
      if (matchesUndefined(read)) {throw error;}
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The error decoder uses this query's own dialect.
      return { error: read as QueryError<D> };
    },
  );

export const tryNativeResult = <Value, D extends Dialect>(call: () => Value, dialect: DialectFor<D>): TryResult<Value, QueryError<D>> => {
  try {
    return { value: call() };
  } catch (error) {
    // oxlint-disable-next-line node/no-sync -- The public trySync API decodes a driver rejection before returning.
    const read = readQueryErrorSync(dialect(), error);
    if (matchesUndefined(read)) {throw error;}
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The error decoder uses this query's own dialect.
    return { error: read as QueryError<D> };
  }
};
