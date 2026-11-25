// oxlint-disable-next-line rules/no-node-imports -- The pg fixtures provide the native client's emitter contract.
import { EventEmitter } from "node:events";
// oxlint-disable-next-line rules/no-node-imports -- Verify the exact driver results in the native runner.
import assert from "node:assert/strict";
import { parseArray } from "#reylo-source/decode.ts";
import type { QueryModule } from "#reylo-source/execute.ts";
import type { Columns } from "#reylo-source/values.ts";
import { isRecord, matchesNull, matchesString, matchesUndefined } from "#reylo-source/native-predicates.ts";
import { promiseDriverStub, requireFixtureValue, SQL_NULL } from "./helpers.ts";
import { asyncDriverMarker, driverMarker } from "./driver-fixtures.ts";

// Fakes of the Postgres drivers that decode as the real ones do (checked against
// Lab/drivers/node_modules and wiki/driver-decoding/spike/postgres.md): a result asks a types
// Table (the query's own, else the client's) for one parser per field and applies it to the
// Field's text. The app's own parsers are hostile here: an int8 its text, a timestamptz tagged,
// An interval an object, an enum upper-cased. Reylo's rows must not see any of them.
export type Parser = (text: string) => unknown;
export const appTable: Record<number, Parser> = {
  1184: (text) => `app:${text}`,
  1186: (text) => ({ interval: text }),
  1231: (text) => parseArray(text, parseFloat),
  20: (text) => text,
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- Match the driver's base-ten integer parser, including its handling of a text suffix.
  23: (text) => Number.parseInt(text, 10),
};
const appTypes = { getTypeParser: (oid: number) => appTable[oid] ?? String };

// Oids the database created: an enum and its array, a domain's array, a row type's array, the
// Array of a type whose delimiter is not a comma (PostGIS's geometry), pgvector's vector and an
// Hstore and their arrays, and a type created after Reylo first read the catalog.
export const ROLE_ARR = 70_000;
export const ROLE = 70_001;
export const POSINT_ARR = 70_010;
const POSINT = 70_011;
export const PAIR_ARR = 70_020;
const PAIR = 70_021;
const LATE_ARR = 70_030;
const LATE = 70_031;
export const SHAPE_ARR = 70_040;
const SHAPE = 70_041;
export const VEC_ARR = 70_050;
export const VEC = 70_051;
export const HSTORE_ARR = 70_060;
export const HSTORE = 70_061;
const OID = {
  bool: 16,
  boxArray: 1020,
  bytea: 17,
  date: 1082,
  int4: 23,
  int4Array: 1007,
  int8: 20,
  interval: 1186,
  intervalArray: 1187,
  jsonb: 3802,
  nameArray: 1003,
  numericArray: 1231,
  text: 25,
  timestamp: 1114,
  timestamptz: 1184,
};
const NO_BASE_ARRAY_OID = 0;
const CATALOG_COLUMN_COUNT = 6;

type RawColumn = [name: string, dataTypeID: number, value: string | null];
export const COLUMNS: RawColumn[] = [
  ["roles", ROLE_ARR, "{admin,member,NULL}"],
  ["role", ROLE, "admin"],
  ["names", OID.nameArray, "{a,b}"],
  ["posints", POSINT_ARR, "{1,2}"],
  ["pairs", PAIR_ARR, '{"(1,x)"}'],
  ["span", OID.interval, "1 year 2 mons"],
  ["spans", OID.intervalArray, '{"1 day","02:00:00"}'],
  ["amounts", OID.numericArray, "{1.5,12345678901234567890.1}"],
  ["ints", OID.int4Array, "{1,NULL}"],
  ["big", OID.int8, "9007199254740993"],
  ["at", OID.timestamptz, "2024-01-15 10:30:00.123456+02"],
  ["wall", OID.timestamp, "2024-01-15 10:30:00.123456"],
  ["day", OID.date, "2024-01-15"],
  ["doc", OID.jsonb, '{"a":[1,2]}'],
  ["bytes", OID.bytea, String.raw`\x0102ff`],
  ["flag", OID.bool, "t"],
  ["boxes", OID.boxArray, "{(1,1),(0,0);(2,2),(1,1)}"],
  ["shapes", SHAPE_ARR, "{0101:NULL:0102}"],
  ["embedding", VEC, "[1,2.5,-3,1e-07]"],
  ["embeddings", VEC_ARR, '{"[1,2]",NULL,"[3]"}'],
  ["prefs", HSTORE, String.raw`"a"=>"1", "b c"=>NULL, "q\""=>"\\"`],
  ["history", HSTORE_ARR, String.raw`{"\"a\"=>\"1\"",NULL,""}`],
  ["nothing", ROLE_ARR, SQL_NULL],
];
/** The module's columns for the same statement, as a build step writes them (src/loader.ts). */
const columns: Columns = [
  ["roles", "text[]"], ["role", "text"], ["names", "text[]"], ["posints", "int[]"], ["pairs", "text"], ["span", "text"], ["spans", "text[]"], ["amounts", "decimal[]"], ["ints", "int[]"],
  ["big", "int8"], ["at", "timestamptz"], ["wall", "timestamp"], ["day", "date"], ["doc", "json"], ["bytes", "bytes"], ["flag", "bool"], ["boxes", "text[]"], ["shapes", "text[]", ":"], ["embedding", "vector"], ["embeddings", "vector[]"], ["prefs", "hstore"], ["history", "hstore[]"], ["nothing", "text[]"],
];

// The catalog, as decode.ts reads it: [array oid, element's base oid, a row type's array (kept as
// Text), delimiter, element oid, base type's name], for a type or an array type it asks about.
type CatalogType = [array: number, base: number, isText: boolean, delimiter: string, element: number, name: string];
type RawRow = (string | null)[];

interface CatalogAnswer { fields: DriverField[]; raw: RawRow[] }

interface CatalogFixture {
  answer: (text: string) => CatalogAnswer;
  catalogQueries: string[];
  late: () => void;
}

const catalogRows = function (text: string, types: CatalogType[]): RawRow[] {
  const match = requireFixtureValue(/any\('\{(?<oids>[\d,]+)\}'/u.exec(text));
  const names = requireFixtureValue(match.groups?.oids).split(",");
  const wanted = new Set(names.map(Number));
  // A requested array has a row after its element's row, as in a real catalog query.
  return types.flatMap(([array, base, isText, delimiter, element, name]) => [
    ...(wanted.has(array) || wanted.has(element) ? [[array, base, isText, delimiter, element, name]] : []),
    ...(wanted.has(array) ? [[NO_BASE_ARRAY_OID, array, true, ",", array, `_${name}`]] : []),
  ]).map((row) => row.map(String));
};

const returnedColumns = function (text: string): CatalogAnswer {
  const cols = [...COLUMNS];
  if (text.includes("late")) {cols.push(["lates", LATE_ARR, "{x,y}"], ["late", LATE, "x"]);}
  return { fields: cols.map(([name, dataTypeID]) => ({ dataTypeID, name })), raw: [cols.map((column) => column[2])] };
};

export const database = function (): CatalogFixture {
  const types: CatalogType[] = [
    [ROLE_ARR, ROLE, false, ",", ROLE, "role"],
    [POSINT_ARR, OID.int4, false, ",", POSINT, "int4"],
    [PAIR_ARR, PAIR, true, ",", PAIR, "pair"],
    [SHAPE_ARR, SHAPE, false, ":", SHAPE, "geometry"],
    [VEC_ARR, VEC, false, ",", VEC, "vector"],
    [HSTORE_ARR, HSTORE, false, ",", HSTORE, "hstore"],
  ];
  const catalogQueries: string[] = [];
  const late = (): void => {types.push([LATE_ARR, LATE, false, ",", LATE, "late"]);};
  const answer = (text: string): CatalogAnswer => {
    if (!text.includes("pg_catalog.pg_type")) {return returnedColumns(text);}
    catalogQueries.push(text);
    const fields = Array.from({ length: CATALOG_COLUMN_COUNT }, (_value, index) => ({ dataTypeID: OID.text, name: `c${index}` }));
    return { fields, raw: catalogRows(text, types) };
  };
  return { answer, catalogQueries, late };
};

const bytes = (input: unknown): unknown => {
  if (input instanceof Uint8Array) {return { bytes: [...input] };}
  if (Array.isArray(input)) {return input.map((item) => bytes(item));}
  if (!isRecord(input) || input instanceof Date) {return input;}
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, bytes(value)]));
};

export const same = (actual: unknown, expected: unknown): void => {
  assert.deepEqual(bytes(actual), bytes(expected));
};

export interface Config {
  text: string;
  values?: unknown[];
  types?: { getTypeParser: (oid: number, format?: string) => Parser };
  rowMode?: string;
}

interface DriverField { dataTypeID: number; name: string }

export interface PgFixtureResult {
  fields: DriverField[];
  rows: (unknown[] | Record<string, unknown>)[];
}

export interface PgFixtureClient extends EventEmitter {
  binary: boolean;
  calls: unknown[];
  getTypeParser: (oid: number, format?: string) => Parser;
  query: (config: string | Config, values?: unknown[]) => Promise<PgFixtureResult>;
  setTypeParser: (oid: number, parser: Parser) => void;
}

// Pg's Client: a query's own table, else the client's setTypeParser over the app's global table.
export const pgClient = function (catalog: CatalogFixture, options: { binary?: boolean } = {}): PgFixtureClient {
  const overrides: Record<number, Parser> = {};
  // oxlint-disable-next-line unicorn/prefer-event-target -- pg exposes EventEmitter listener methods to consumers.
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    binary: options.binary ?? false,
    calls: [] as unknown[],
    getTypeParser: (oid: number, _format?: string) => overrides[oid] ?? appTypes.getTypeParser(oid),
    query: promiseDriverStub((config: string | Config, values?: unknown[]): PgFixtureResult => {
      client.calls.push(config);
      const statement: Config = matchesString(config) ? { text: config, ...(values ? { values } : {}) } : config;
      const types = statement.types ?? client;
      const answer = catalog.answer(statement.text);
      const parsers = answer.fields.map((field) => types.getTypeParser(field.dataTypeID, client.binary ? "binary" : "text"));
      const rows = answer.raw.map((raw) => {
        const decoded = raw.map((rawValue, index) => (matchesNull(rawValue) ? SQL_NULL : requireFixtureValue(parsers[index])(rawValue)));
        return statement.rowMode === "array" ? decoded : Object.fromEntries(answer.fields.map((field, index) => [field.name, decoded[index]]));
      });
      return { fields: answer.fields, rows };
    }),
    setTypeParser: (oid: number, parser: Parser) => {overrides[oid] = parser;},
  });
  return client;
};

export const probe: QueryModule<"postgres"> = { dialect: "postgres", params: ["id"], sql: "select * from probe where id = :id" };
export const built: QueryModule<"postgres"> = { ...probe, columns };
export const lateProbe: QueryModule<"postgres"> = { dialect: "postgres", params: ["id"], sql: "select *, late from probe where id = :id" };

// Pg's Pool: no getTypeParser; query() runs on a client it checks out, whose `connect` listeners set parsers.
interface PgPoolFixture extends EventEmitter {
  Client: abstract new () => object;
  clients: PgFixtureClient[];
  connect: () => Promise<PgFixtureClient>;
  options: { binary?: boolean; max: number };
  query: PgFixtureClient["query"];
}

export const pgPool = function (catalog: CatalogFixture): PgPoolFixture {
  const clients: ReturnType<typeof pgClient>[] = [];
  const options: { binary?: boolean; max: number } = { max: 2 };
  // oxlint-disable-next-line unicorn/prefer-event-target -- pg Pool reports connections through EventEmitter.
  const emitter = new EventEmitter();
  const pool = Object.assign(emitter, {
    // oxlint-disable-next-line typescript/no-extraneous-class -- pg Pool exposes its Client constructor, which this fixture only identifies.
    Client: class {},
    clients,
    connect: promiseDriverStub(() => {
      const connection = pgClient(catalog);
      pool.emit("connect", connection);
      clients.push(connection);
      return Object.assign(connection, { release: driverMarker });
    }),
    options,
    async query(config: string | Config, values?: unknown[]): Promise<PgFixtureResult> {
      const connection = await pool.connect();
      return connection.query(config, values);
    },
  });
  return pool;
};

// PGlite: a query's parsers merged over the instance's, as its parse.ts does.
interface PgliteOptions { parsers?: Record<number, Parser>; rowMode?: string }

interface PgliteFixture {
  exec: () => Promise<unknown[]>;
  query: (text: string, values?: unknown[], options?: PgliteOptions) => Promise<PgFixtureResult>;
  seen: Record<number, Parser>[];
  parsers?: Record<number, Parser>;
  refreshArrayTypes?: () => Promise<void>;
  closed?: boolean;
  rollback?: () => Promise<void>;
}

const parsePgliteCell = (value: string | null, field: DriverField | undefined, parsers: Record<number, Parser>): unknown => {
  if (matchesNull(value)) {return SQL_NULL;}
  const parser = parsers[requireFixtureValue(field).dataTypeID];
  return matchesUndefined(parser) ? value : parser(value);
};

export const pglite = function (catalog: CatalogFixture, instance?: Record<number, Parser>): PgliteFixture {
  const seen: Record<number, Parser>[] = [];
  return {
    ...(instance ? { parsers: instance, refreshArrayTypes: asyncDriverMarker } : { closed: false, rollback: asyncDriverMarker }),
    exec: promiseDriverStub(() => []),
    query: promiseDriverStub((text: string, _values?: unknown[], options?: PgliteOptions): PgFixtureResult => {
      if (options?.parsers) {seen.push(options.parsers);}
      const answer = catalog.answer(text);
      const parsers = { ...instance, ...options?.parsers };
      const rows = answer.raw.map((raw) => {
        const values = raw.map((value, index) => parsePgliteCell(value, answer.fields[index], parsers));
        return options?.rowMode === "array" ? values : Object.fromEntries(answer.fields.map((field, index) => [field.name, values[index]]));
      });
      return { fields: answer.fields, rows };
    }),
    seen,
  };
};

// Postgres.js: `.raw()` gives each value's bytes and the result's columns; a row transform runs on raw rows too.
interface PostgresJsFixture {
  typed: (value: unknown, type: number) => { type: number; value: unknown };
  unsafe: (text: string) => { raw: () => Promise<unknown[] & { columns: { name: string; type: number }[] }> };
}

export const postgresJs = function (catalog: CatalogFixture, rowTransform?: (row: unknown[]) => unknown): PostgresJsFixture {
  return {
    typed: (value: unknown, type: number) => ({ type, value }),
    unsafe: (text: string) => ({
      raw: promiseDriverStub(() => {
        const answer = catalog.answer(text);
        const rows = answer.raw.map((row) => row.map((value) => (matchesNull(value) ? SQL_NULL : Buffer.from(value))));
        return Object.assign(rowTransform ? rows.map((row) => rowTransform(row)) : rows, { columns: answer.fields.map((field) => ({ name: field.name.toUpperCase(), type: field.dataTypeID })) });
      }),
    }),
  };
};
