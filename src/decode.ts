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
import { lexPlaceholders } from "./lex.ts";
import { hasFunctionType, matchesNull, matchesString, matchesUndefined } from "./native-predicates.ts";
import { coerce, DecodeError, textDecoder } from "./values.ts";
import type { Columns, Decoder, Kind } from "./values.ts";

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

// ---------------------------------------------------------------------------------------------
// Slonik: its query() runs only the queries its `sql` tag builds, and its type parsers are set on
// The pool's connections, where they turn a numeric into a float, a timestamp into epoch
// Milliseconds and an interval into seconds. A tag made by the app's own `createSqlTag` with
// `typeParsers` (Slonik 49.12.0 and later) overrides them for its queries alone, so Reylo's passes
// Every type that pg or Slonik converts through as the server's text, and decodes the rows itself.
// Each parameter appears once in a statement (upstream engine/core/src/lex.rs), so the statement is the
// Tag's template as it stands: its text between the placeholders, and the values in their order.

interface SlonikTypeParser { name: string; parse(value: string): unknown }
interface SlonikQuery { typeParsers?: unknown }
interface SlonikTag { unsafe(strings: TemplateStringsArray, ...values: unknown[]): SlonikQuery }
interface SlonikModule { createSqlTag(configuration: { typeParsers: SlonikTypeParser[] }): SlonikTag }
interface SlonikConfiguration {
  interceptors?: { transformRow?: unknown; transformRowAsync?: unknown }[];
  typeParsers?: SlonikTypeParser[];
}
type SlonikProtocol = {
  clientConfiguration?: SlonikConfiguration;
  configuration?: SlonikConfiguration;
  query: (query: SlonikQuery) => PromiseLike<{
    fields: { dataTypeId: number; name: string }[];
    rows: Record<string, unknown>[];
  }>;
};

/**
 * The built-in types pg's parsers (pg-types 4) or Slonik's own convert, each passed through as its
 * text; arrays of them follow. pg leaves every other type, and an array of one, as text or as an
 * array of its elements' text.
 */
const SLONIK_TEXT = [
  "bool", "bytea", "int2", "int4", "int8", "oid", "float4", "float8", "numeric", "money", "date", "timestamp", "timestamptz", "interval",
  "json", "jsonb", "point", "circle", "int4range", "int8range", "numrange", "tsrange", "tstzrange", "daterange",
];

/** Kinds whose value must reach Reylo as text: anything else is one a driver already converted, and may have rounded. */
const SLONIK_STRICT = /^(?:decimal|date|timestamp|timestamptz|interval)(?:\[\])*$/u;
const FIRST_PARAMETER_POSITION = 1;
const KIND_START = 0;
const ARRAY_KIND_SUFFIX = "[]";

let slonikModule: SlonikModule | undefined;
const slonikTags = new Map<string, SlonikTag>();

interface NodeProcess { argv?: string[]; cwd: () => string; getBuiltinModule?(id: string): { createRequire(from: string): (id: string) => unknown } | undefined }

/**
 * The app's own `slonik`, the package its pool came from, loaded the first time a Slonik client is
 * passed. It is required through Node's `createRequire`, reached with `process.getBuiltinModule`
 * (Node 20.16 and Bun) rather than an import, so that a bundler finds nothing to resolve or warn
 * about in an app without Slonik; from the app's entry script, then from its working directory.
 */
const loadSlonik = function (): SlonikModule {
  if (slonikModule) {return slonikModule;}
  const proc = (globalThis as { process?: NodeProcess }).process;
  const createRequire = proc?.getBuiltinModule?.("node:module")?.createRequire;
  if (!proc || !createRequire) {throw new TypeError(`Reylo runs a query on Slonik with a sql tag from the app's own slonik package, which it loads through Node's process.getBuiltinModule, and this runtime has none.`);}
  let failure: unknown;
  for (const from of [proc.argv?.[1], `${proc.cwd()}/`]) {
    if (!from) {continue;}
    try {
      return (slonikModule = createRequire(from)("slonik") as SlonikModule);
    } catch (error) {
      failure = error;
    }
  }
  throw new TypeError(`Reylo runs a query on Slonik with a sql tag from the app's own slonik package, which it could not load (a server that is bundled keeps slonik external, so that it loads from node_modules at run time): ${(failure as Error).message}`);
};

const slonikTag = function (client: SlonikProtocol): SlonikTag {
  const { createSqlTag } = loadSlonik();
  // The parsers the app made its pool with, which a pool names on `configuration` and its
  // Connections, transactions and savepoints on `clientConfiguration` (not in Slonik's types).
  const own = (client.configuration ?? client.clientConfiguration)?.typeParsers?.map((parser) => parser.name) ?? [];
  const names = [...new Set([...SLONIK_TEXT, ...own])];
  const key = names.join(",");
  let tag = slonikTags.get(key);
  if (matchesUndefined(tag)) {slonikTags.set(key, (tag = createSqlTag({ typeParsers: names.map((name) => ({ name, parse: (value: string) => value })) })));}
  return tag;
};

/** `text`, a statement with `$n` placeholders each used once, as a template literal's strings, and its values in that order. */
const slonikTemplate = function (text: string, values: Readonly<unknown[]>): [TemplateStringsArray, unknown[]] {
  const { params, placeholders } = lexPlaceholders(text, "postgres");
  // A query defined by hand may use a parameter twice, which the type check refuses: Slonik's tag
  // Binds every value on its own, so the second use would be a parameter of its own type.
  if (placeholders.length > params.length) {
    throw new TypeError(`Reylo cannot run this statement on Slonik: it uses a parameter more than once, and Slonik's sql tag binds each use on its own, so the server would type each one separately. Use each parameter once, and select it in a with to read it twice.`);
  }
  const strings: string[] = [];
  let last = 0;
  Iterator.from(placeholders).forEach((p) => {
    strings.push(text.slice(last, p.start));
    last = p.end;
  });
  strings.push(text.slice(last));
  // A tag takes only what a template literal gives it: frozen strings and their raw form.
  const template = Object.freeze(Object.assign(strings, { raw: Object.freeze([...strings]) })) as unknown as TemplateStringsArray;
  return [template, placeholders.map((placeholder) => values[Number(placeholder.name) - FIRST_PARAMETER_POSITION])];
};

export const slonik = async function slonik(client: Record<string, unknown>, text: string, values: Readonly<unknown[]>, columns: Columns | undefined): Promise<unknown[]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The caller has selected the Slonik driver using its connection methods.
  const driver = client as SlonikProtocol;
  // An interceptor's transformRow or transformRowAsync renames the columns
  // (slonik-interceptor-field-name-transformation) or rewrites each row, which Reylo's types would
  // No longer describe. It is refused before the statement runs, since a write that committed and
  // Then reported an error invites a retry.
  const interceptors = (driver.configuration ?? driver.clientConfiguration)?.interceptors;
  if (interceptors?.some((interceptor) => hasFunctionType(interceptor?.transformRow) || hasFunctionType(interceptor?.transformRowAsync))) {throw refuseSlonikRows();}
  const tag = slonikTag(driver);
  const [template, ordered] = slonikTemplate(text, values);
  const query = tag.unsafe(template, ...ordered);
  if (matchesUndefined(query.typeParsers)) {
    throw new TypeError(`Reylo cannot run on this Slonik: its sql tag takes no type parsers per query (createSqlTag's typeParsers option), so its pool's parsers would turn numeric, timestamp and interval values into lossy numbers. Upgrade slonik to 49.12.0 or later.`);
  }
  const result = await driver.query(query);
  return slonikRows(result.rows, result.fields, columns);
};

/** Slonik's rows in Reylo's representation, by each column's kind, or for a query defined by hand by its type's oid. */
function slonikRows(rows: Record<string, unknown>[], fields: { name: string; dataTypeId: number }[], columns: Columns | undefined): unknown[] {
  if (!rows.length) {return rows;}
  const work: Readonly<(Readonly<[string, Kind, string?]>)[]> =
    columns ??
    fields.map((field) => {
      const b = builtin(field.dataTypeId);
      return b ? ([field.name, b.kind, b.delim] as const) : ([field.name, "text"] as const);
    });
  Iterator.from(rows).forEach((row) => {
    for (const [name, kind, delim] of work) {row[name] = slonikValue(kind, row[name], name, delim);}
  });
  return rows;
}

/** A value as Slonik gave it: the server's text for every type Reylo's tag names, a value pg converted for the rest. */
function slonikValue(kind: Kind, v: unknown, name: string, delim?: string): unknown {
  if (matchesNull(v) || matchesUndefined(v)) {return null;}
  if (matchesString(v)) {return textDecoder(kind, delim)(v);}
  // Pg parses an array's text into an array, each element by the element type's parser, which
  // Reylo's tag passes through for the types it names.
  if (Array.isArray(v) && kind.endsWith(ARRAY_KIND_SUFFIX)) {
    const elementKind = kind.slice(KIND_START, -ARRAY_KIND_SUFFIX.length);
    return v.map((value) => slonikValue(Array.isArray(value) ? kind : elementKind, value, name, delim));
  }
  if (SLONIK_STRICT.test(kind)) {
    throw new DecodeError(`Column "${name}" reached Reylo already converted by Slonik's driver (${v instanceof Date ? "a Date" : typeof v}), which ignored the query's type parsers, as a custom driverFactory may: Reylo refuses it rather than return a value that may have been rounded.`);
  }
  return coerce(kind, v, name, delim);
}

const refuseSlonikRows = () =>
  new TypeError(`Reylo cannot run on this Slonik client: one of its interceptors rewrites every row (transformRow or transformRowAsync, such as slonik-interceptor-field-name-transformation), Reylo's too, so they would not have the columns the query declares. Run Reylo's queries on a pool made without that interceptor.`);

export { bunRows } from "./decode-bun.ts";
export { postgresJs } from "./decode-postgres-js.ts";
export { DecodeError, parseArray } from "./values.ts";
