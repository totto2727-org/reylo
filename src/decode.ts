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
import { pgFamily, refuseBinary } from "./decode-pg-rows.ts";
import { asText, callPg, queryPg, rowsOf } from "./decode-pg-wire.ts";
import type { CatalogRow, PgClient, PgResult, PgRow, PgRows, PgStatement, PgTypeTable } from "./decode-pg-wire.ts";
import type { Load } from "./decode-postgres-catalog.ts";
import { isPglite, pglite } from "./decode-pglite.ts";
import { hasFunctionType, isEmptyArray } from "./native-predicates.ts";
import type { Columns } from "./values.ts";

const textCatalogRequest = (text: string): { rowMode: "array"; text: string; types: typeof asText } =>
  // oxlint-disable-next-line eslint/sort-keys -- Pg wrappers observe options in the existing text, rowMode, types order.
  ({ text, rowMode: "array", types: asText });

const textRowRequest = (text: string, values: unknown[], types: PgTypeTable): { text: string; types: PgTypeTable; values: unknown[] } =>
  // oxlint-disable-next-line eslint/sort-keys -- Pg wrappers observe options in the existing text, values, types order.
  ({ text, values, types });

const objectQueryCatalog = (client: PgClient): Load => async (sql) => {
  const result = await queryPg<PgRows<CatalogRow>>(client, textCatalogRequest(sql));
  return result.rows;
};

const pgClientOrPool = async (client: PgClient, { columns, text, values }: PgStatement, binary: unknown): Promise<unknown[]> => {
  if (binary === true) {throw refuseBinary();}
  const catalog = { key: client, load: objectQueryCatalog(client) };
  return pgFamily(catalog, (types) => queryPg<PgResult<PgRow>>(client, textRowRequest(text, values, types)), columns);
};

const refuseReceive = (): TypeError =>
  // oxlint-disable-next-line rules/require-tagged-error -- Unsupported receive hooks keep the existing native TypeError without importing Effect.
  new TypeError("Reylo cannot run on this pg-promise database: its receive event rewrites every result, Reylo's rows too, so they would not have the types the query declares. Run Reylo's queries on a database initialized without receive (pgp({ ... }) with no receive), or on its pool (db.$pool).");

// Pg-promise uses a bound { text, values, types } object on databases, tasks, and transactions.
// The database exposes receive options. For a task, compare the result keys to compiled columns.
const FIRST_ROW = 0;

const pgPromise = async (db: PgClient, { columns, text, values }: PgStatement): Promise<unknown[]> => {
  if (hasFunctionType(db.$config?.options?.receive)) {throw refuseReceive();}
  const method = (): "query" | "result" => hasFunctionType(db.result) ? "result" : "query";
  const load: Load = async (sql) =>
    rowsOf(await callPg<PgResult<CatalogRow>>(db, method(), [textCatalogRequest(sql)]));
  const rows = await pgFamily({ key: db, load }, (types) =>
    callPg<PgResult<PgRow>>(db, method(), [textRowRequest(text, values, types)]), columns);
  const first = rows[FIRST_ROW];
  if (first && columns && !isEmptyArray(columns) && !columns.every(([name]) => Object.hasOwn(first, name))) {
    throw refuseReceive();
  }
  return rows;
};

interface NeonOptions<Row> {
  arrayMode: Row extends CatalogRow ? true : false;
  fullResults: true;
  types: PgTypeTable;
}

const neonRowOptions = (types: PgTypeTable): NeonOptions<PgRow> =>
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the options order used by the callable and method forms.
  ({ fullResults: true, arrayMode: false, types });

const neonCatalogOptions: NeonOptions<CatalogRow> = { arrayMode: true, fullResults: true, types: asText };

const neonMethod = async (client: PgClient, { columns, text, values }: PgStatement): Promise<unknown[]> => {
  const load: Load = async (sql) => {
    const result = await queryPg<PgRows<CatalogRow>>(client, sql, [], { ...neonCatalogOptions });
    return result.rows;
  };
  return pgFamily({ key: client, load }, (types) =>
    queryPg<PgResult<PgRow>>(client, text, values, neonRowOptions(types)), columns);
};

const poolOrNeon = async (client: PgClient, request: PgStatement): Promise<unknown[]> => {
  // The pool passes its own types table with the query when it checks out a client.
  if (hasFunctionType(client.connect) && hasFunctionType(client.Client)) {
    return pgClientOrPool(client, request, client.options?.binary);
  }
  // Neon 1.0 takes a per-query types table and returns fields when fullResults is set.
  if (hasFunctionType(client.transaction)) {return neonMethod(client, request);}
  return rowsOf(await queryPg<PgResult<PgRow>>(client, request.text, request.values));
};

/**
 * Selects the Postgres wire protocol for a client, pool, wrapper or transaction.
 * @param {PgClient} client - The app's driver object.
 * @param {string} text - The statement text.
 * @param {unknown[]} values - The bound values.
 * @param {Columns | undefined} columns - The compiled columns, when available.
 * @returns {Promise<unknown[]>} Result rows in the compiled representation.
 */
// oxlint-disable-next-line eslint/max-params -- Preserve the existing SQL driver entry point and keep inputs separate.
export const queryPostgres = async function queryPostgres(client: PgClient, text: string, values: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  const request = { columns, text, values };
  if (hasFunctionType(client.manyOrNone)) {return pgPromise(client, request);}
  if (hasFunctionType(client.getTypeParser)) {return pgClientOrPool(client, request, client.binary);}
  if (isPglite(client)) {return pglite(client, request);}
  return poolOrNeon(client, request);
};

/**
 * Runs a query through the callable neon() protocol before Neon 1.0.
 * @param {object} client - The app's callable Neon query function.
 * @param {string} text - The statement text.
 * @param {unknown[]} values - The bound values.
 * @param {Columns | undefined} columns - The compiled columns, when available.
 * @returns {Promise<unknown[]>} Result rows in the compiled representation.
 */
// oxlint-disable-next-line eslint/max-params, typescript/promise-function-async -- Preserve the original callable protocol and return the decoding Promise directly.
export const neonCallable = function neonCallable(client: object, text: string, values: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dispatch selected a callable protocol and its options determine the response shape.
  const query = client as <Row>(text: string, values: unknown[], options: NeonOptions<Row>) => PromiseLike<PgRows<Row>>;
  const load: Load = async (sql) => {
    const result = await query<CatalogRow>(sql, [], { ...neonCatalogOptions });
    return result.rows;
  };
  return pgFamily({ key: client, load }, (types) => query<PgRow>(text, values, neonRowOptions(types)), columns);
};

export { bunRows } from "./decode-bun.ts";
export { postgresJs } from "./decode-postgres-js.ts";
export { slonik } from "./decode-slonik.ts";
export { DecodeError, parseArray } from "./values.ts";
