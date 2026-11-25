// Standard Query: a SQL statement a driver can execute, as a typed function from an input to an
// Output. A query is a Standard Typed (its `~standard.types` are the input and the output), and
// `~standard.query` holds the statement, the database it is written for, and two mappings: from
// The input to the values the driver binds, and from the rows the driver reads raw to the output.
// A driver that supports it runs the statement with `encode`'s values, reads every row as an
// Array of raw values with its own conversions off, and returns what `decode` returns.
//
// Every Reylo query is one, with the same input and output as `.run()`: `encode` binds as
// `.run()` binds, its checks included, and `decode` gives each value its kind and the result its
// Cardinality as `.run()` does. Two things `.run()` does need its client, and a Standard Query,
// Which has none, does neither: it never checks that the schema still matches the one the
// Statement was typed against (src/fresh.ts), and on MySQL it keeps a DATETIME's, TIMESTAMP's or
// TIME's fraction digits as the driver read them, which are the column's own over the text
// Protocol, while mysql2's binary protocol drops trailing zeros (`.000`) that `.run()` writes back
// From the column's metadata.
import { normalize } from "./decode-sqlite.ts";
import { compile, rawStatement, sentText } from './execute.ts';
import type { Dialect as EngineDialect, QueryModule } from './execute.ts';
import type { StandardTypedV1 } from "./standard.ts";
import { coerce, DecodeError, textDecoder } from "./values.ts";
import { matchesNullish, matchesString, matchesUndefined, nonemptyText } from "./native-predicates.ts";

/** The Standard Query interface: a statement a driver can execute, as a typed function from an input to an output. */
export interface StandardQueryV1<Input = unknown, Output = Input, D extends StandardQueryV1.Dialect = StandardQueryV1.Dialect>
  extends StandardTypedV1<Input, Output> {
  /** The Standard properties. */
  // oxlint-disable-next-line rules/no-readonly -- Preserve the public Standard Query contract.
  readonly "~standard": StandardQueryV1.Props<Input, Output, D>;
}

// oxlint-disable-next-line typescript/no-namespace -- Retain the public Standard QueryV1 type namespace.
export declare namespace StandardQueryV1 {
  /** The Standard Query properties interface. */
  export interface Props<Input = unknown, Output = Input, D extends Dialect = Dialect>
    extends StandardTypedV1.Props<Input, Output> {
    /** The statement and its two mappings. */
    // oxlint-disable-next-line rules/no-readonly -- Preserve the public Standard Query contract.
    readonly query: Query<Output, D>;
  }

  /** The Standard Query query interface. */
  export interface Query<Output = unknown, D extends Dialect = Dialect> {
    /** The database the statement is written for. A driver refuses a query for another one. */
    // oxlint-disable-next-line rules/no-readonly -- Preserve the public Standard Query contract.
    readonly dialect: D;
    /** The statement, with the database's positional placeholders: `$1`, `$2` on Postgres, `?` on MySQL and SQLite. */
    // oxlint-disable-next-line rules/no-readonly -- Preserve the public Standard Query contract.
    readonly text: string;
    /**
     * Maps the input to the values to bind, one per placeholder, in order, each in its database's
     * raw form. The driver passes the input as the caller gave it, `undefined` when it was left
     * out. Throws a `TypeError` for an input it cannot bind.
     */
    // oxlint-disable-next-line typescript/method-signature-style -- Preserve the standard method signature and its variance.
    encode(input: unknown): Readonly<RawValue<D>[]>;
    /**
     * Maps the raw result to the output: every row the statement returned, each an array of raw
     * values in the order the statement selects them. Throws for a result that does not fit the
     * output (a second row where at most one is expected, say).
     */
    // oxlint-disable-next-line typescript/method-signature-style -- Preserve the standard method signature and its variance.
    decode(rows: Readonly<(Readonly<RawValue<D>[]>)[]>): Output;
  }

  /** The database a statement is written for. */
  export type Dialect =
    | "postgres"
    | "mysql"
    | "sqlite"
    // Accepts any string: allows other databases while preserving autocomplete
    // oxlint-disable-next-line typescript/ban-types -- Preserve dialect completion while accepting driver-defined names.
    | ({} & string);

  /**
   * A value in its raw form: what a driver of the database reads before converting anything, and
   * binds without converting anything. On Postgres, the value's text as the server sends it in
   * the text format. NULL is `null`.
   */
  export type RawValue<D extends Dialect = Dialect> =
    | null
    | (D extends "postgres" ? string : D extends "mysql" | "sqlite" ? string | number | bigint | Uint8Array : unknown);

  /** The arguments a driver takes after the query: optional when the input can be empty. */
  // oxlint-disable-next-line typescript/ban-types, typescript/no-empty-object-type -- The standard makes input optional when it accepts an empty object.
  export type InferArgs<Q extends StandardTypedV1> = {} extends StandardTypedV1.InferInput<Q>
    ? [input?: StandardTypedV1.InferInput<Q>]
    : [input: StandardTypedV1.InferInput<Q>];
}

type Columns = NonNullable<QueryModule["columns"]>;
type Decoder = (value: unknown) => unknown;
type Rows<Database extends EngineDialect> = Readonly<Readonly<StandardQueryV1.RawValue<Database>[]>[]>;

const postgresDecoder = (name: string, kind: string, delimiter: string | undefined): Decoder => {
  const fromText = textDecoder(kind, delimiter);
  return (value) => {
    if (!matchesString(value)) {
      throw new DecodeError(`Column "${name}" is not in Postgres's text form: a driver hands a Standard Query each value's text.`);
    }
    return fromText(value);
  };
};

const decoder = (dialect: EngineDialect, [name, kind, delimiter]: Columns[number]): Decoder => {
  if (dialect === "postgres") {return postgresDecoder(name, kind, delimiter);}
  // MySQL's driver values use a T in the same place as those returned by `.run()`.
  if (kind.split("|").includes("timestamp")) {
    return (value) => matchesString(value) ? value.replace(" ", "T") : coerce(kind, value, name, delimiter);
  }
  return (value) => coerce(kind, value, name, delimiter);
};

const arrayValue = (raw: unknown, index: number, decoders: Decoder[] | undefined): unknown => {
  // oxlint-disable-next-line unicorn/no-null -- The raw Standard Query protocol represents SQL NULL with null.
  if (matchesNullish(raw)) {return null;}
  if (matchesUndefined(decoders)) {return raw;}
  // oxlint-disable-next-line typescript/no-non-null-assertion -- A driver decoder was built for every column in this result.
  return decoders[index]!(raw);
};

const keyedRow = (raw: Readonly<unknown[]>, columns: Columns, decoders: Decoder[] | undefined): Record<string, unknown> => {
  if (raw.length !== columns.length) {
    throw new DecodeError(`The statement selects ${columns.length} columns, and a row has ${raw.length}.`);
  }
  const row: Record<string, unknown> = {};
  Iterator.from(raw.entries()).forEach(([index, item]) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- The validated row width matches the generated column layout.
    const [name] = columns[index]!;
    row[name] = arrayValue(item, index, decoders);
  });
  return row;
};

interface Cache { decoders?: Decoder[]; text?: string }

type StatementText = () => string;

const encodeQuery = <Database extends EngineDialect>(
  module: QueryModule<Database>, statementText: StatementText, input: unknown,
): Readonly<StandardQueryV1.RawValue<Database>[]> => {
  const bound = rawStatement(module, matchesUndefined(input) ? {} : input);
  // A structured MySQL insert can rewrite its column lists to match the keys the caller supplies.
  if (bound.text !== statementText()) {
    const source = nonemptyText(module.source);
    const prefix = matchesUndefined(source) ? "" : `${source}: `;
    // oxlint-disable-next-line rules/require-tagged-error -- Standard Query callers receive the specification's native TypeError without loading Effect.
    throw new TypeError(`${prefix}This statement's text depends on its input (a structured parameter in an insert names the keys it carries), so it runs through .run(), not as a Standard Query.`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Binding uses this query's dialect and therefore returns its native raw values.
  return bound.values as StandardQueryV1.RawValue<Database>[];
};

const decodeRows = <Database extends EngineDialect>(module: QueryModule<Database>, cache: Cache, rows: Rows<Database>): Record<string, unknown>[] => {
  const {columns} = module;
  if (matchesUndefined(columns)) {
    // oxlint-disable-next-line rules/require-tagged-error -- Standard Query reports an incomplete handwritten descriptor with a native TypeError.
    throw new TypeError("A query defined by hand without its columns cannot map rows to its output: a module a build step writes carries them.");
  }
  // SQLite's native normalizer checks each configured storage class and integer representation.
  const {dialect} = module;
  const sqlite = dialect === "sqlite";
  if (!sqlite) {cache.decoders ??= columns.map((column) => decoder(dialect, column));}
  const keyed = rows.map((raw) => keyedRow(raw, columns, sqlite ? undefined : cache.decoders));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SQLite normalizes each keyed row object using the same column names.
  return sqlite ? normalize(keyed, columns) as Record<string, unknown>[] : keyed;
};

/**
 * Create the driver-facing descriptor with Reylo's binding, decoding, and result cardinality.
 * @template Database, Output
 * @param {QueryModule<Database>} module - The analyzed statement and database binding metadata.
 * @param {(rows: Record<string, unknown>[]) => Output} materialize - The query's cardinality conversion.
 * @returns {StandardQueryV1.Query<Output, Database>} The Standard Query descriptor.
 */
export const standardQuery = function standardQuery<Database extends EngineDialect, Output>(
  module: QueryModule<Database>, materialize: (rows: Record<string, unknown>[]) => Output,
): StandardQueryV1.Query<Output, Database> {
  const cache: Cache = {};
  // The methods close over the module so drivers can call either function on its own.
  const statementText = (): string => {
    cache.text ??= sentText(module, compile(module).text);
    return cache.text;
  };
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the published Standard Query descriptor's established key order.
  return {
    dialect: module.dialect,
    get text() {return statementText();},
    encode(input) {return encodeQuery(module, statementText, input);},
    decode(rows) {return materialize(decodeRows(module, cache, rows));},
  };
};
