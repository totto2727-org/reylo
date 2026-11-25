// Reylo decodes every value of its own Postgres queries itself, on the app's own client, pool,
// Connection or transaction, so that a row has the type the module declares however the app set
// Up its driver (the representation is src/values.ts). It never opens
// A connection, never mutates the app's object, and never changes the app's other queries. Every
// Driver but Bun.sql hands over each value as the server's text, and only the per-type choice that
// Follows is Reylo's (wiki/driver-decoding/spike/postgres.md):
//
// - pg's Client, PoolClient and Pool, pg-promise, Neon's Pool and Client, @vercel/postgres and
//   Neon's neon() take a decoder table per query (`{ text, values, types }`). Reylo's answers every
//   Oid itself: a parser the app registered (globally, on a pool or a client) never applies to
//   Reylo's query, and pg's own (an interval object, a lossy numeric[], an enum array as text)
//   Neither.
// - PGlite takes a per-query `parsers` table, which it merges over the instance's: the table names
//   The statement's own oids, learned from its earlier runs, since PGlite copies the whole table on
//   Every query (a table of every oid cost +70% on a one-row query).
// - postgres.js takes no decoder per query: `.raw()` hands over each value's bytes, past the app's
//   `types` and value and column transforms, and Reylo builds the rows with the module's column
//   Names.
// - Bun.sql decodes in native code and takes nothing per query: Reylo converts the values it got
//   (src/values.ts, `coerce`), by each column's kind.
//
// A built-in type (an oid below 10000, the same in every database and version) has its kind here.
// A type the database created (an enum, a domain's array, an extension's type) has the kind the
// Module gives its column; for a query defined by hand, one catalog query per client reads which of
// Those oids are arrays, cached in a WeakMap keyed by the app's object.
import { builtin, builtinDecoder, builtinOids, fieldDecoders, FIRST_USER_OID, learn, learnedOf } from "./decode-postgres-catalog.ts";
import type { Field, Load } from "./decode-postgres-catalog.ts";
import { hasFunctionType, matchesNull, matchesString, matchesUndefined } from "./native-predicates.ts";
import { coerce, textDecoder } from "./values.ts";
import type { Columns, Decoder } from "./values.ts";

// ---------------------------------------------------------------------------------------------
// Pg and everything built on it: a per-query table that answers every oid.

/** The text of a value whose type the database created and Reylo had not met; decoded before `run` returns. */
class Pending {
  public readonly oid: number;
  public readonly text: string;
  public constructor(oid: number, text: string) {
    this.oid = oid;
    this.text = text;
  }
}
/** A value pg read in the binary format, which pg 8.23 cannot read (it corrupts an int8). */
const BINARY = Symbol("binary");

interface PgTypeTable {
  getTypeParser: (oid: number, format?: string) => Decoder;
}

interface PgTypeObservation {
  sawBinary: () => boolean;
  sawPending: () => boolean;
  table: PgTypeTable;
}

/** The decoder table for one query on a pg-family client, which never falls back to the client's own parsers. */
const pgTypes = function (key: object): PgTypeObservation {
  const known = learnedOf(key);
  const observed = { binary: false, pending: false };
  const table = {
    getTypeParser(oid: number, format?: string): Decoder {
      if (!matchesUndefined(format) && format !== "text") {
        observed.binary = true;
        return () => BINARY;
      }
      const decoder = builtinDecoder(oid);
      if (decoder) {return decoder;}
      const learnedType = known.get(oid);
      if (learnedType) {return textDecoder(learnedType.kind, learnedType.delim);}
      observed.pending = true;
      return (text) => new Pending(oid, text);
    },
  };
  return { sawBinary: () => observed.binary, sawPending: () => observed.pending, table };
};

const refuseBinary = () =>
  new TypeError(`Reylo cannot read this pg client's results: it was set up with binary: true (or pg.defaults.binary), which pg 8 reads wrong (an int8 comes back as another number). Reylo decodes every value from the server's text; leave binary off.`);

interface PgField {
  dataTypeID: number;
  name: string;
}

interface PgRows<Row> {
  fields?: PgField[] | null;
  rows: Row[];
}

type PgRow = Record<string, unknown>;
type CatalogRow = (string | null)[];
type PgResult<Row> = PgRows<Row> | (Row[] & { fields?: PgField[] | null });
type PgArguments = [request: object] | [text: string, values: unknown[], options?: object];
type PgClient = Record<string, unknown> & {
  $config?: { options?: { receive?: unknown } };
  options?: { binary?: unknown };
};

const callPg = <Result>(client: PgClient, method: "query" | "result", args: PgArguments): PromiseLike<Result> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Existing driver detection selects the pg protocol; each call describes the rows selected by its options.
  (client[method] as (...values: PgArguments) => PromiseLike<Result>)(...args);

const queryPg = <Result>(client: PgClient, ...args: PgArguments): PromiseLike<Result> =>
  callPg<Result>(client, "query", args);

const rowsOf = <Row>(result: PgResult<Row>): Row[] => Array.isArray(result) ? result : result.rows;

/**
 * Runs the query with Reylo's table through `run`, then decodes the values of the types the
 * database created that Reylo met for the first time, by the module's columns or the catalog.
 */
const pgFamily = async function (key: object, run: (types: PgTypeTable) => PromiseLike<PgResult<PgRow>>, columns: Columns | undefined, load: Load): Promise<PgRow[]> {
  const types = pgTypes(key);
  const result = await run(types.table);
  const rows = rowsOf(result);
  if (types.sawBinary()) {throw refuseBinary();}
  if (!types.sawPending()) {return rows;}
  // Learned from the module's columns where the result has their fields, else from the catalog.
  if (result.fields && !Array.isArray(result)) {
    await fieldDecoders(result.fields.map((field) => ({ name: field.name, oid: field.dataTypeID })), columns, { key, load });
  }
  const oids = new Set<number>();
  Iterator.from(rows).forEach((row) => {Object.values(row).forEach((v) => {if (v instanceof Pending) {oids.add(v.oid);}});});
  await learn({ key, load }, oids);
  const known = learnedOf(key);
  const decoders = new Map([...oids].map((oid) => [oid, textDecoder(known.get(oid)!.kind, known.get(oid)!.delim)]));
  Iterator.from(rows).forEach((row) => {
    for (const name in row) {
      const v = row[name];
      if (v instanceof Pending) {row[name] = decoders.get(v.oid)!(v.text);}
    }
  });
  return rows;
};

/** A decoder table that keeps every value its text: the catalog's rows, whatever the app registered. */
const asText = { getTypeParser: () => (x: string) => x };

const objectQueryCatalog = (client: PgClient): Load => async (sql) => {
  const result = await queryPg<PgRows<CatalogRow>>(client, { text: sql, rowMode: "array", types: asText });
  return result.rows;
};

/**
 * Runs a Postgres statement on a client whose query() Reylo calls: pg's Client, PoolClient and
 * Pool, Neon's, @vercel/postgres's, pg-promise's database, tasks and transactions, PGlite and its
 * transactions, and Neon's neon(). Each is told apart by what it has.
 */
export const queryPostgres = async function queryPostgres(client: PgClient, text: string, values: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  // Pg-promise formats the values into the text itself (reading $1 inside a string literal
  // Too) unless it is handed a { text, values } object, which it binds.
  if (hasFunctionType(client.manyOrNone)) {return pgPromise(client, text, values, columns);}
  // Pg's Client and PoolClient, Neon's, and @vercel/postgres's VercelClient.
  if (hasFunctionType(client.getTypeParser)) {
    if (client.binary === true) {throw refuseBinary();}
    return pgFamily(client, (types) => queryPg<PgResult<PgRow>>(client, { text, values, types }), columns, objectQueryCatalog(client));
  }
  // PGlite and its transactions.
  if (isPglite(client)) {return pglite(client, text, values, columns);}
  // Pg's Pool, Neon's and @vercel/postgres's: query() checks a client out of the pool, and the
  // Table goes with the query, so a `connect` listener's parsers do not apply either.
  if (hasFunctionType(client.connect) && hasFunctionType(client.Client)) {
    if (client.options?.binary === true) {throw refuseBinary();}
    return pgFamily(client, (types) => queryPg<PgResult<PgRow>>(client, { text, values, types }), columns, objectQueryCatalog(client));
  }
  // Neon's neon() from 1.0: query(text, params, options) replaces Neon's whole table with the
  // Query's, and returns the fields with `fullResults`.
  if (hasFunctionType(client.transaction)) {
    const load: Load = async (sql) => {
      const result = await queryPg<PgRows<CatalogRow>>(client, sql, [], { arrayMode: true, fullResults: true, types: asText });
      return result.rows;
    };
    return pgFamily(client, (types) => queryPg<PgResult<PgRow>>(client, text, values, { fullResults: true, arrayMode: false, types }), columns, load);
  }
  const result = await queryPg<PgResult<PgRow>>(client, text, values);
  return rowsOf(result);
};

// Pg-promise sends a { text, values, types } object to pg as it is, on the database, a task or a
// Transaction. Its `receive` event runs on every result, Reylo's too, and may rewrite the rows: on
// The database Reylo reads it from the options and refuses; a task exposes no options, so a
// Receive that renamed the columns is caught by the rows' keys.
async function pgPromise(db: PgClient, text: string, values: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  if (hasFunctionType(db.$config?.options?.receive)) {throw refuseReceive();}
  const method = (): "query" | "result" => hasFunctionType(db.result) ? "result" : "query";
  const load: Load = async (sql) => {
    const result = await callPg<PgResult<CatalogRow>>(db, method(), [{ text: sql, rowMode: "array", types: asText }]);
    return rowsOf(result);
  };
  // A task's or transaction's connection is not reachable, so what Reylo learns is kept per object.
  const rows = await pgFamily(db, (types) => callPg<PgResult<PgRow>>(db, method(), [{ text, values, types }]), columns, load);
  const first = rows[0];
  if (first && columns?.length && !columns.every(([name]) => Object.hasOwn(first, name))) {throw refuseReceive();}
  return rows;
}

const refuseReceive = () =>
  new TypeError(`Reylo cannot run on this pg-promise database: its receive event rewrites every result, Reylo's rows too, so they would not have the types the query declares. Run Reylo's queries on a database initialized without receive (pgp({ ... }) with no receive), or on its pool (db.$pool).`);

/** Neon's neon() before 1.0, a function called with (text, params, options), whose options take `types` (0.9 too, undocumented). */
export const neonCallable = function neonCallable(client: object, text: string, values: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  type QueryOptions<Row> = { arrayMode: Row extends CatalogRow ? true : false; fullResults: true; types: PgTypeTable };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dispatch has selected the callable Neon protocol; its options select the returned row format.
  const query = client as <Row>(text: string, values: unknown[], options: QueryOptions<Row>) => PromiseLike<PgRows<Row>>;
  const load: Load = async (sql) => {
    const result = await query<CatalogRow>(sql, [], { arrayMode: true, fullResults: true, types: asText });
    return result.rows;
  };
  return pgFamily(client, (types) => query<PgRow>(text, values, { fullResults: true, arrayMode: false, types }), columns, load);
};

// ---------------------------------------------------------------------------------------------
// PGlite

const isPglite = (client: PgClient): boolean => hasFunctionType(client.query) && hasFunctionType(client.exec) && (hasFunctionType(client.refreshArrayTypes) || (hasFunctionType(client.rollback) && "closed" in client));

/** The oids each statement's result had on its earlier runs, by the statement's text: PGlite's per-query table names only those. */
const pgliteOids = new Map<string, Set<number>>();
const PGLITE_STATEMENTS = 2000;
const keepText = (x: string): string => x;

async function pglite(db: PgClient, text: string, values: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  // A statement met for the first time names every built-in type Reylo decodes, and every oid the
  // Instance has a parser for (its arrays, and the app's); a transaction has no table to read.
  let named = pgliteOids.get(text);
  const oids = named ?? new Set([...builtinOids, ...Object.keys(db.parsers ?? {}).map(Number)]);
  const parsers: Record<number, Decoder> = {};
  Iterator.from(oids).forEach((oid) => {parsers[oid] = builtinDecoder(oid) ?? keepText;});
  const { rows, fields: columnMetadata } = await queryPg<PgRows<PgRow>>(db, text, values, { rowMode: "object", parsers });
  const fields: Field[] = (columnMetadata ?? []).map(({ name, dataTypeID }) => ({ name, oid: dataTypeID }));
  // Created types, which the table kept as text, and an oid the table did not name, which went
  // Through the instance's parser.
  const after = fields.map((field, index) => [field, index] as const).filter(([f]) => f.oid >= FIRST_USER_OID || !oids.has(f.oid));
  if (after.length) {
    const load: Load = async (sql) => {
      const result = await queryPg<PgRows<CatalogRow>>(db, sql, [], { rowMode: "array", parsers: { 25: keepText } });
      return result.rows;
    };
    const decoders = await fieldDecoders(fields, columns, { key: db, load });
    const kinds = fields.map((field, index) => (columns && columns.length === fields.length ? columns[index]![1] : (builtin(field.oid)?.kind ?? learnedOf(db).get(field.oid)?.kind ?? "text")));
    Iterator.from(after).forEach(([f, i]) => {
      const decode = decoders[i]!;
      for (const row of rows) {
        const v = row[f.name];
        if (!matchesNull(v) && !matchesUndefined(v)) {row[f.name] = matchesString(v) ? decode(v) : coerce(kinds[i]!, v, f.name);}
      }
    });
  }
  if (!named || fields.some((field) => !named!.has(field.oid))) {
    if (pgliteOids.size >= PGLITE_STATEMENTS) {pgliteOids.clear();}
    pgliteOids.set(text, (named = new Set([...(named ?? []), ...fields.map((field) => field.oid)])));
  }
  return rows;
}

export { bunRows } from "./decode-bun.ts";
export { postgresJs } from "./decode-postgres-js.ts";
export { slonik } from "./decode-slonik.ts";
export { DecodeError, parseArray } from "./values.ts";
