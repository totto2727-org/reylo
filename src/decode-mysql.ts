// Reylo decodes every value of its own MySQL queries itself, on the app's own pool, connection or
// Transaction (the representation is src/values.ts). Each driver but
// Bun.sql takes its decoding choices per query, laid over the app's without changing them
// (wiki/driver-decoding/spike/mysql.md):
//
// - mysql2 stays on `execute`, the binary protocol (its `query` writes the values into the text
//   With backslash escapes, which matched every row of a table under NO_BACKSLASH_ESCAPES). Its
//   Per-query options make a BIGINT and a date the server's text, and Reylo's per-query `typeCast`
//   Reads a DECIMAL and a JSON value as their text, which the app's `decimalNumbers` and
//   `jsonStrings` (read from the app's config only) would otherwise decide; it runs only where a
//   Statement or the app's settings need it, since mysql2 calls it for every value. A BIGINT's
//   Exact text becomes a BigInt, by the result's own column type, and a date's dropped zero
//   Fraction comes back from the result's fields. `decimalNumbers` is never passed per query:
//   Mysql2 keys its row-parser cache, shared by every pool in the process, by the per-query value
//   And builds the parser from the app's, so one query would poison another pool's parser.
// - mariadb takes every option per query, both ways: a BIGINT is its own BigInt (mariadb 2's too), and
//   `metaAsArray: false` keeps the rows an array of rows. A SET comes back an array, which no
//   Option prevents: Reylo joins it.
// - PlanetScale takes a `cast` per query, which replaces the app's: Reylo's is the driver's own
//   Default, with a BIGINT a BigInt and a DATETIME's `T`.
// - Bun.sql takes nothing per query: its values are converted (src/decode.ts, `bunRows`).
//
// MySQL has no boolean type: a TINYINT(1), a BIT(1) and a comparison are integers to every driver,
// And a column whose kind is `bool` (src/values.ts) is made a boolean after the driver, a value
// Other than 0 or 1 refused (`truth`).
import { coerce, utf8 } from "./values.ts";
import { jsonValue } from "./value-text.ts";
import type { Columns } from './values.ts';
import { hasFunctionType, isEmptyArray, matchesNull, matchesNullish, matchesString, matchesUndefined } from "./native-predicates.ts";

import { byKind, columnFixes, fixRows, toBigInt } from "./decode-mysql-columns.ts";
import type { DriverRow, Fix } from "./decode-mysql-columns.ts";

export { planetscale } from "./decode-planetscale.ts";
// ---------------------------------------------------------------------------------------------
// Mysql2

/** Options mysql2 ORs with the app's (a BIGINT and a date as text) and the row's shape, which the query's own replace. */
// oxlint-disable-next-line eslint/sort-keys -- Preserve the adapter's existing driver option enumeration order.
const MYSQL2_OPTIONS = { supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, rowsAsArray: false, nestTables: false };

interface Mysql2Field { type: string; string: (encoding?: string) => string | null; buffer: () => Uint8Array | null }

/**
 * Reylo's typeCast: a DECIMAL as its text and a JSON value parsed from its bytes (both are
 * length-coded in the binary protocol too, so they read whole), JSON here because mysql2's own
 * parser turns an integer past 2^53 inside a document into a string under `supportBigNumbers`; a
 * GEOMETRY as its bytes; every other type mysql2's own reading with the options above.
 * @param {Mysql2Field} field - The field the binary parser exposes.
 * @param {() => unknown} next - Runs the driver's default cast.
 * @returns {unknown} The decoded value.
 */
const mysql2Cast = function (field: Mysql2Field, next: () => unknown): unknown {
  switch (field.type) {
    case "NEWDECIMAL":
    case "DECIMAL": {
      return field.string("ascii");
    }
    case "JSON": {
      const bytes = field.buffer();
      return matchesNull(bytes) ? bytes : jsonValue(utf8(bytes));
    }
    case "GEOMETRY": {
      return field.buffer();
    }
    default: {
      return next();
    }
  }
};

/** A column's protocol type and fraction digits, as mysql2's fields give them. */
interface Mysql2Column { name: string; columnType: number; decimals: number }
const DATETIME = 12;
const TIMESTAMP = 7;
const TIME = 11;
const NO_DECIMALS = 0;
const NO_POINT = -1;
const AFTER_POINT = 1;
const MAX_DECIMALS = 6;

const fractionText = (text: string, decimals: number): string => {
  if (!(decimals > NO_DECIMALS)) {return text;}
  const point = text.indexOf(".");
  return point === NO_POINT ? `${text}.${"0".repeat(decimals)}` : text.padEnd(point + AFTER_POINT + decimals, "0");
};

// Mysql2's binary protocol can drop fractional trailing zeros in temporal fields.
const wallClock = (text: string, decimals: number, type: number): string => {
  const padded = fractionText(text, decimals);
  return type === TIME ? padded : padded.replace(" ", "T");
};

/** The app's settings, where mysql2 shows them: a promise Pool's, Connection's or PoolConnection's. */
interface Mysql2Config { typeCast?: unknown; decimalNumbers?: boolean; jsonStrings?: boolean }
interface Mysql2Protocol {
  connection?: { config?: Mysql2Config };
  execute: (
    options: typeof MYSQL2_OPTIONS & { sql: string; typeCast: true | typeof mysql2Cast },
    values: unknown[],
  ) => PromiseLike<[DriverRow[] | object, Mysql2Column[] | null | undefined]>;
  pool?: { config?: { connectionConfig?: Mysql2Config } };
}
const configOf = (client: Mysql2Protocol): Mysql2Config | undefined => client.pool?.config?.connectionConfig ?? client.connection?.config;

/**
 * Whether the statement needs Reylo's typeCast, which mysql2 calls for every value of the binary
 * protocol (about 70 ns each): for a JSON or GEOMETRY column, whenever the columns are not known,
 * and where the app's settings, which a query cannot turn off, would decide a DECIMAL or a JSON value
 * or replace mysql2's own reading (or cannot be read).
 * @param {Mysql2Protocol} client - The native client supplying its app settings.
 * @param {Columns | undefined} columns - The generated output kinds, when known.
 * @returns {boolean} Whether to install Reylo's own type cast.
 */
const needsCast = function (client: Mysql2Protocol, columns: Columns | undefined): boolean {
  if (!columns || columns.some(([, kind]) => kind === "unknown" || kind.split("|").some((part) => part === "json" || part.startsWith("json")))) {return true;}
  const config = configOf(client);
  return matchesUndefined(config) || hasFunctionType(config.typeCast) || config.decimalNumbers === true || config.jsonStrings === true;
};

/** Mysql2's protocol type of a BIGINT (MYSQL_TYPE_LONGLONG). */
const LONGLONG = 8;

const nativeFixes = (fields: Mysql2Column[], columns: Columns | undefined): Readonly<[string, Fix]>[] => {
  // The module's kinds apply only when all result columns line up with the generated ones.
  const kinds = columns && columns.length === fields.length ? columns : undefined;
  const fixes: Readonly<[string, Fix]>[] = [];
  fields.forEach((field, index) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- The generated column array is dense and the count check aligns it with native fields.
    const fix = byKind(kinds?.[index]![1]) ?? (field.columnType === LONGLONG ? toBigInt : undefined);
    if (fix) {fixes.push([field.name, fix]);}
  });
  Iterator.from(fields).forEach((field) => {
    if (field.columnType === DATETIME || field.columnType === TIMESTAMP || (field.columnType === TIME && field.decimals > NO_DECIMALS)) {
      const precision = field.decimals > MAX_DECIMALS ? NO_DECIMALS : field.decimals;
      const { columnType } = field;
      fixes.push([field.name, (value) => matchesString(value) ? wallClock(value, precision, columnType) : value]);
    }
  });
  return fixes;
};

/**
 * Runs a query through mysql2's binary-protocol execute API.
 * @param {DriverRow} client - The native mysql2 connection or pool.
 * @param {string} text - The SQL statement.
 * @param {unknown[]} values - Its bindings.
 * @param {Columns | undefined} columns - The generated output kinds, when known.
 * @returns {Promise<unknown[]>} The native result rows after conversion.
 */
// oxlint-disable-next-line eslint/max-params -- Preserve the positional MySQL adapter API used by the query dispatcher.
export const mysql2 = async function mysql2(client: DriverRow, text: string, values: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dispatch identifies the native mysql2 execute protocol before entering this adapter.
  const driver = client as DriverRow & Mysql2Protocol;
  const [rows, fields] = await driver.execute({ sql: text, ...MYSQL2_OPTIONS, typeCast: needsCast(driver, columns) ? mysql2Cast : true }, values);
  if (!Array.isArray(rows)) {return [];}
  fixRows(rows, nativeFixes(fields ?? [], columns));
  return rows;
};

// ---------------------------------------------------------------------------------------------
// Mariadb

/**
 * Every decoding option, each laid over the app's for this query (mariadb's parser.js:
 * Object.assign(Object.create(connOpts), opts)). mariadb 3: with `bigIntAsNumber` and
 * `supportBigNumbers` off a BIGINT is its own BigInt, and with `decimalAsNumber` off too a DECIMAL
 * its text (`bigNumberStrings` matters only beside `supportBigNumbers`). mariadb 2, which has none
 * of the first two: `supportBigInt` makes a BIGINT a BigInt and `bigNumberStrings` a DECIMAL its
 * text, where it would be a lossy number.
 */
// oxlint-disable-next-line eslint/sort-keys -- Preserve the enumeration order of the options passed to the native MariaDB driver.
const MARIADB_OPTIONS = {
  bigIntAsNumber: false,
  decimalAsNumber: false,
  supportBigNumbers: false,
  bigNumberStrings: true,
  supportBigInt: true,
  checkNumberRange: false,
  dateStrings: true,
  jsonStrings: false,
  autoJsonMap: true,
  bitOneIsBoolean: false,
  rowsAsArray: false,
  nestTables: false,
  metaAsArray: false,
  typeCast: undefined,
};

// Use GEOMETRY's bytes when a query could otherwise receive GeoJSON from the driver.
const mariadbGeometry = (column: { type: string; buffer: () => unknown }, next: () => unknown): unknown => (column.type === "GEOMETRY" ? column.buffer() : next());

interface MariadbColumn { type?: string; columnType?: number; name?: string | (() => string); isSet?: () => boolean }
type MariadbResult = (DriverRow[] | object) & { meta?: MariadbColumn[] };
interface MariadbProtocol {
  query: (
    options: Omit<typeof MARIADB_OPTIONS, "typeCast"> & { sql: string; typeCast: typeof mariadbGeometry | undefined },
    values: unknown[],
    callback: (error: Error | null, rows: MariadbResult, meta?: MariadbColumn[]) => void,
  ) => { then?: (resolve: (rows: MariadbResult) => void, reject: (error: unknown) => void) => unknown } | null | undefined;
}

interface MariaWork {
  date: boolean;
  name: string;
}

const describeMariaField = (field: MariadbColumn): { name: string | undefined; set: boolean; type: string | undefined } => {
  const name = hasFunctionType(field.name) ? field.name() : field.name;
  const { type } = field;
  const set = (hasFunctionType(field.isSet) && field.isSet()) || field.type === "SET";
  return { name, set, type };
};

const mariaColumns = (columns: Columns | undefined, metadata: Readonly<MariadbColumn[]>): MariaWork[] => {
  if (columns) {
    return columns.filter(([, kind]) => kind === "text" || kind.split("|").includes("timestamp"))
      .map(([name, kind]) => ({ date: kind !== "text", name }));
  }
  // Older driver versions expose SET only in the field type.
  return metadata.map((field) => describeMariaField(field)).flatMap(({ name, set, type }) => {
    if (matchesUndefined(name) || (!set && type !== "DATETIME" && type !== "TIMESTAMP")) {return [];}
    return [{ date: !set, name }];
  });
};

const applyMariaColumns = (rows: DriverRow[], work: Readonly<MariaWork[]>): void => {
  if (isEmptyArray(work)) {return;}
  Iterator.from(rows).forEach((row) => {
    Iterator.from(work).forEach(({ date, name }) => {
      const value = row[name];
      if (matchesNullish(value)) {return;}
      if (Array.isArray(value)) {row[name] = coerce("text", value, name);}
      else if (date && matchesString(value)) {row[name] = value.replace(" ", "T");}
    });
  });
};

/**
 * Runs a query through MariaDB's native callback or promise API.
 * @param {DriverRow} client - The native MariaDB connection or pool.
 * @param {string} text - The SQL statement.
 * @param {unknown[]} values - Its bindings.
 * @param {Columns | undefined} columns - The generated output kinds, when known.
 * @returns {Promise<unknown[]>} The native result rows after conversion.
 */
// oxlint-disable-next-line eslint/max-params -- Preserve the positional MySQL adapter API used by the query dispatcher.
export const mariadb = async function mariadb(client: DriverRow, text: string, values: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  const options = { sql: text, ...MARIADB_OPTIONS, ...(columns?.some(([, kind]) => kind === "unknown") === true ? { typeCast: mariadbGeometry } : {}) };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dispatch identifies the native MariaDB query protocol before entering this adapter.
  const driver = client as DriverRow & MariadbProtocol;
  const callback: { metadata: MariadbColumn[] | undefined } = { metadata: undefined };
  // oxlint-disable-next-line promise/avoid-new -- Bridge the native driver callback and its optional PromiseLike while preserving first settlement.
  const result = await new Promise<MariadbResult>((resolve, reject) => {
    const returned = driver.query(options, values, (error, rows, metadata) => {
      if (error) {reject(error);}
      else {
        callback.metadata = metadata;
        resolve(rows);
      }
    });
    // oxlint-disable-next-line promise/catch-or-return, promise/prefer-catch -- Some MariaDB versions return a PromiseLike without catch. Both settlement handlers are required.
    if (hasFunctionType(returned?.then)) {returned.then(resolve, reject);}
  });
  if (!Array.isArray(result)) {return [];}
  const work = mariaColumns(columns, columns ? [] : result.meta ?? callback.metadata ?? []);
  fixRows(result, columnFixes(columns));
  applyMariaColumns(result, work);
  return result;
};
