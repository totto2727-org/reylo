// Reylo gives every value of its own SQLite queries its type itself (the
// Representation is src/values.ts). Every SQLite driver already turns each storage class into
// A JavaScript value in native code, and they agree but on two: an INTEGER (a number that may be
// Rounded past 2^53, an error, a BigInt, or libSQL's string) and a BLOB (a Buffer, a Uint8Array, an
// ArrayBuffer or D1's array of numbers). And only the analysis knows that a TEXT holds JSON or that
// An INTEGER is a truth value. So Reylo normalizes the driver's rows, by each column's kind where the
// Module carries it (wiki/driver-decoding/spike/sqlite.md):
//
// - better-sqlite3, node:sqlite and bun:sqlite: Reylo prepares its own statement on the app's
//   Database, once per database and text (a WeakMap keyed by the database), and sets that
//   Statement's own integer mode, whatever the database's, and no other statement of the app's
//   Changes. node:sqlite's statement, and better-sqlite3's and bun:sqlite's where a column has no
//   Type the module knows or is a BIGINT's (`int8`, a BigInt), read every INTEGER as a BigInt: an
//   INTEGER's is then a number, or an error naming its column past 2^53. Where every column is
//   Typed and none is a BIGINT's, better-sqlite3's and bun:sqlite's read numbers (a BigInt per
//   Integer cost +70% on 10,000 rows when `exactInteger` compared BigInts, and +17 to 20% since it
//   Converts first, which is also what a five-column row costs with one of its INTEGER columns
//   Declared BIGINT), and a number past 2^53 in a column that may hold an INTEGER can only be a
//   Rounded one, which is refused. bun:sqlite's statement comes from
//   `prepare`, never `query`, whose cache by text would carry Reylo's mode into the app's statement.
// - Turso's new engine (@tursodatabase/database): Reylo prepares its statement and sets its integer
//   Mode as on better-sqlite3, per call and closed after it, since a Transaction's statements end
//   With it and a 0.4 statement run twice could lose its rows; the promise API's statement is
//   Awaited, the compat Database's answers at once. Its BLOB is a Buffer and its BOOLEAN 0 or 1, as
//   On better-sqlite3; at its defaults an INTEGER past 2^53 comes back rounded, with no error.
// - A Durable Object's `ctx.storage.sql`: exec()'s cursor, read whole. An INTEGER past 2^53 comes
//   Back rounded, with no error, and a BLOB as an ArrayBuffer.
// - sqlite3 and the sqlite wrapper, libSQL, D1 and Bun.SQL's SQLite: the rows the driver gives,
//   Normalized. sqlite3 and sqlite are not cached: a statement left open makes the app's close()
//   Fail with SQLITE_BUSY. An INTEGER the driver already rounded (sqlite3, sqlite, D1, Bun.SQL
//   Without safeIntegers) is refused in an INTEGER or BIGINT column, where a number past 2^53 can
//   Only be one; a BIGINT's number within 2^53, or libSQL's BigInt or digits, is its BigInt.
import { bigInteger, coerce, DecodeError, exactInteger, refuseTruth, truth } from './values.ts';
import type { Columns, Kind } from './values.ts';
import { hasFunctionType, isEmptyArray, matchesBigInt, matchesNull, matchesNumber, matchesString, matchesUndefined } from "./native-predicates.ts";

type SqliteClient = Record<string, unknown>;

interface Statement {
  all: (...bindings: unknown[]) => unknown[] | PromiseLike<unknown[]>;
  close?: () => void;
  columns?: () => { name: string }[];
  reader?: boolean;
  run: (...bindings: unknown[]) => unknown;
  safeIntegers?: (enabled: boolean) => unknown;
  setReadBigInts?: (enabled: boolean) => unknown;
  setReturnArrays?: (enabled: boolean) => unknown;
}

/** Reylo's statement, whether it reads every INTEGER as a BigInt, and whether it is kept for the next call. */
interface Kept {
  exact: boolean;
  kept: boolean;
  statement: Statement;
}

const statements = new WeakMap<object, Map<string, Kept>>();
/** How many statements Reylo keeps per database: more distinct texts than that drop the oldest. */
const KEPT = 500;

const prepare = <Result>(database: SqliteClient, text: string): Result =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SQLite dispatch selects the native prepare protocol and whether its statement is awaited.
  (database.prepare as (sql: string) => Result)(text);

const cacheFor = (database: SqliteClient, keep: boolean): Map<string, Kept> | undefined => {
  const previous = statements.get(database);
  if (previous || !keep) {return previous;}
  const cache = new Map<string, Kept>();
  statements.set(database, cache);
  return cache;
};

const configureIntegerRead = (statement: Statement, typed: boolean): boolean => {
  // Node:sqlite's StatementSync; better-sqlite3's and bun:sqlite's Statement.
  if (hasFunctionType(statement.setReadBigInts)) {
    statement.setReadBigInts(true);
    if (hasFunctionType(statement.setReturnArrays)) {statement.setReturnArrays(false);}
    return true;
  }
  if (hasFunctionType(statement.safeIntegers)) {
    statement.safeIntegers(!typed);
    return !typed;
  }
  return false;
};

const remember = (cache: Map<string, Kept>, key: string, entry: Kept): void => {
  if (cache.size >= KEPT) {
    const oldest = cache.keys().next();
    if (!oldest.done) {cache.delete(oldest.value);}
  }
  cache.set(key, entry);
};

/**
 * Reylo's own statement for `text` on the app's database, with integers read as BigInts. Turso's
 * compat Database (maxWriteReplicationIndex()) gets a new statement per call, closed after it: on
 * 0.4 a statement with a subquery run a second time returned no rows.
 * @param {SqliteClient} database - The driver's existing database instance.
 * @param {string} text - The statement text.
 * @param {boolean} typed - Whether every column can be decoded without reading integers as BigInts.
 * @returns {Kept} The prepared statement and its read mode.
 */
const statementFor = function (database: SqliteClient, text: string, typed: boolean): Kept {
  const keep = !hasFunctionType(database.maxWriteReplicationIndex);
  const cache = cacheFor(database, keep);
  const key = `${typed ? "n" : "b"}${text}`;
  const found = cache?.get(key);
  if (found) {return found;}
  const statement = prepare<Statement>(database, text);
  const entry = { exact: configureIntegerRead(statement, typed), kept: keep, statement };
  if (cache) {remember(cache, key, entry);}
  return entry;
};

// Every column typed: a number past 2^53 in one can be told as rounded (src/values.ts). A column
// Read as a BigInt (`int8`) needs the statement's integers exact.
const everyColumnTyped = function everyColumnTyped(columns: Columns | undefined): boolean {
  return !matchesUndefined(columns) && columns.length > 0 && !columns.some(([, kind]) => kind === "unknown" || kind.split("|").includes("int8"));
};

/**
 * Runs `text` on a synchronous SQLite database (better-sqlite3, node:sqlite, bun:sqlite, Turso's
 * compat Database) and returns its normalized rows; a statement that answers through a promise (no
 * such database) gives the promise, which `runSync` refuses.
 */
export const runSyncSqlite = function runSyncSqlite(database: SqliteClient, text: string, values: unknown[], columns: Columns | undefined): unknown[] | Promise<unknown[]> {
  const entry = statementFor(database, text, everyColumnTyped(columns));
  if (entry.kept) {return runStatement(entry, values, columns);}
  try {
    return runStatement(entry, values, columns);
  } finally {
    entry.statement.close?.();
  }
};

function runStatement({ statement, exact }: Kept, values: unknown[], columns: Columns | undefined): unknown[] | Promise<unknown[]> {
  // Better-sqlite3 refuses all() on a statement that returns no rows.
  if (reader(statement) === false) {
    statement.run(...values);
    return [];
  }
  const all = statement.all(...values);
  if (!Array.isArray(all)) {return Promise.resolve(all).then((rows) => normalize(rows, columns));}
  let rows = all;
  // A database opened with returnArrays, on a Node whose statements cannot turn it off.
  if (rows.length && Array.isArray(rows[0]) && hasFunctionType(statement.columns)) {
    const names = statement.columns().map(({ name }) => name);
    rows = (rows as unknown[][]).map((currentRow) => Object.fromEntries(names.map((currentName, index) => [currentName, currentRow[index]])));
  }
  return normalize(rows, columns, { exact });
}

// Whether the statement returns rows: undefined where it cannot say, as Turso 0.4's compat statement,
// Whose `reader` throws "not implemented" and whose all() runs any statement.
function reader(statement: Statement): boolean | undefined {
  try {
    return statement.reader;
  } catch {
    return undefined;
  }
}

/**
 * Runs `text` on Turso's promise API (a Database from `connect()`, or the Transaction
 * `transactionAsync()` hands its callback) and returns its normalized rows. Its prepare() returns
 * the statement (its types say a promise of it from 0.6, so it is awaited), whose all() runs a
 * statement that returns no rows as well; the statement is closed after its one run.
 */
export const runTurso = async function runTurso(database: SqliteClient, text: string, values: unknown[], columns: Columns | undefined): Promise<unknown[]> {
  const typed = everyColumnTyped(columns);
  const statement = await prepare<Statement | PromiseLike<Statement>>(database, text);
  try {
    if (hasFunctionType(statement.safeIntegers)) {statement.safeIntegers(!typed);}
    return normalize(await statement.all(...values), columns, { exact: !typed });
  } finally {
    if (hasFunctionType(statement.close)) {statement.close();}
  }
};

/**
 * Runs `text` on a SQLite-backed Durable Object's SQL storage (`ctx.storage.sql`), whose exec()
 * answers at once with a cursor, and returns its normalized rows. Its integers are numbers, so one
 * past 2^53 in an INTEGER column can only be a rounded one, and is refused.
 */
export const runDurableObject = function runDurableObject(sql: SqliteClient, text: string, values: unknown[], columns: Columns | undefined): unknown[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A Durable Object's native exec method returns a cursor before this synchronous path returns.
  const cursor = (sql.exec as (query: string, ...bindings: unknown[]) => { toArray: () => unknown[] })(text, ...values);
  return normalize(cursor.toArray(), columns);
};

interface Plan {
  name: string;
  /** An INTEGER the driver read as a BigInt. */
  big: (value: bigint) => unknown;
  /** A number, where it may need converting: a truth value, or an INTEGER a driver may have rounded. */
  num: ((value: number) => unknown) | undefined;
  /** A string, where it may need converting: JSON, a truth value, libSQL's integer under intMode "string". */
  str: ((value: string) => unknown) | undefined;
  /** A BLOB in a column whose type holds none. */
  blob?: ((value: object) => never) | undefined;
}

/** An integer's digits, as libSQL under intMode "string" hands one over. */
const DIGITS = /^[+-]?\d+$/u;

/** A REAL's, an INTEGER's or a NUMERIC's column (`int|float|text`, the one kind a NUMERIC has), where integer digits can only be an INTEGER's. */
const numericOnly = function numericOnly(kinds: string[]): boolean {
  return kinds.every((candidateKind) => candidateKind === "int" || candidateKind === "float") || (kinds.length === 3 && kinds.includes("int") && kinds.includes("float") && kinds.includes("text"));
};

/**
 * What each column's values need, worked out once per call rather than per value. SQLite holds a
 * column to its declared type only in a STRICT table: elsewhere it stores a value of any storage
 * class in any column, the text 'abc' in an INTEGER column and a BLOB in a TEXT one, and a column
 * declared BOOLEAN holds whatever was stored in it. A value the column's type does not allow is
 * refused, naming the column, rather than returned as what the type says it is not (`refuseClass`,
 * and `truth` in src/values.ts, since a truth value is 0 or 1 in every SQLite driver).
 */
const plan = function (name: string, kind: Kind, exact: boolean): Plan {
  if (kind === "bool") {return { name, big: (value) => truth(value, name), num: (value) => truth(value, name), str: (value) => truth(value, name), blob: () => refuseTruth(name, "a BLOB") };}
  if (kind === "json") {return { name, big: (value) => exactInteger(value, name), num: undefined, str: (value) => JSON.parse(value) };}
  const kinds = kind.split("|");
  const refuse = (value: unknown): never => refuseClass(name, kinds, value);
  // A column with no type, or ANY in a STRICT table, is `unknown`, and takes any value.
  const any = kinds.includes("unknown");
  const texts = any || kinds.includes("text");
  const numbers = any || kinds.some((candidateKind) => candidateKind === "int" || candidateKind === "float" || candidateKind === "int8");
  const blob = any || kinds.includes("bytes") ? undefined : refuse;
  // A column declared BIGINT, INT8 or UNSIGNED BIG INT, and what passes one through: a BigInt. A
  // Number past 2^53 is a rounded one where the driver did not read integers exact (sqlite3, D1,
  // LibSQL's intMode "number"), and is refused; a number is a REAL where it did, and a REAL with a
  // Fraction is one either way, which no BigInt holds.
  if (kind === "int8") {return { name, big: (value) => value, num: exact ? refuse : (value) => (Number.isInteger(value) ? bigInteger(value, name) : refuse(value)), str: (value) => (DIGITS.test(value) ? BigInt(value) : refuse(value)), blob };}
  if (kind === "text") {return { name, big: String, num: undefined, str: undefined, blob };}
  if (kind === "int") {return { name, big: (value) => exactInteger(value, name), num: exact ? undefined : (value) => exactInteger(value, name), str: (value) => (DIGITS.test(value) ? exactInteger(BigInt(value), name) : refuse(value)), blob };}
  // LibSQL under intMode "string" hands an INTEGER over as its digits, and says nothing of the storage
  // Class or of its mode. Where the column is a REAL's, or a NUMERIC's, those digits can only be an
  // INTEGER's: SQLite stores text that reads as an integer as that integer in a column of REAL or
  // NUMERIC affinity, and a REAL reaches JavaScript as a number. So they are the integer, exact or
  // Refused. In a column with no type, or one built from what may be TEXT, the digits may be a
  // TEXT's, and stay as the driver gave them (wiki/driver-decoding.md). Any other text in a column of
  // Numbers or BLOBs alone is a TEXT the column's type does not allow.
  const digits = (value: string): string | number => (DIGITS.test(value) ? exactInteger(BigInt(value), name) : (texts ? value : refuse(value)));
  const str = numericOnly(kinds) || (numbers && !texts) ? digits : (texts ? undefined : refuse);
  // A NUMERIC's either: read as numbers, one past 2^53 may be a rounded INTEGER, which is refused.
  if (!exact && kinds.includes("int")) {return { name, big: (value) => exactInteger(value, name), num: (value) => (Number.isInteger(value) ? exactInteger(value, name) : value), str, blob };}
  // A REAL, a NUMERIC read exact, a column with no type: an integer is exact or refused, a number is
  // As it is. A BLOB's column holds no number.
  if (!numbers && !texts) {return { name, big: refuse, num: refuse, str, blob };}
  return { name, big: (value) => exactInteger(value, name), num: undefined, str, blob };
};

const TYPE_NAMES: Readonly<Record<string, string>> = { int: "number", float: "number", int8: "bigint", text: "string", bytes: "Uint8Array" };

/**
 * The error for a value of a storage class the column's type does not allow, which SQLite stores in
 * a table that is not STRICT, as the type and the value the message names them.
 */
function refuseClass(column: string, kinds: string[], value: unknown): never {
  const type = [...new Set(kinds.map((candidateKind) => TYPE_NAMES[candidateKind] ?? candidateKind))].join(" | ");
  const held =
    matchesString(value)
      ? `the text ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`
      : (matchesNumber(value) || matchesBigInt(value)
        ? `the number ${value}`
        : `a BLOB of ${byteLength(value)} byte${byteLength(value) === 1 ? "" : "s"}`);
  throw new DecodeError(
    `Column "${column}" is typed ${type} and holds ${held}: outside a STRICT table SQLite stores a value of any type in any column, and Reylo refuses one its type does not allow rather than return it. Replace the value, or read what the column holds with cast(${column} as text).`,
  );
}

/** A BLOB's length, as each driver hands one over: a Uint8Array or Buffer, libSQL's ArrayBuffer, D1's array of numbers. */
function byteLength(value: unknown): number {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {return value.byteLength;}
  return Array.isArray(value) ? value.length : 0;
}

type Row = Record<string, unknown>;

const normalizeColumn = (row: Row, column: Plan, d1: boolean): void => {
  const value = row[column.name];
  if (matchesNull(value) || matchesUndefined(value)) {return;}
  switch (typeof value) {
    case "bigint": {
      row[column.name] = column.big(value);
      return;
    }
    case "number": {
      if (column.num) {row[column.name] = column.num(value);}
      return;
    }
    case "string": {
      if (column.str) {row[column.name] = column.str(value);}
      return;
    }
    case "object": {
      if (column.blob) {column.blob(value);}
      // LibSQL's ArrayBuffer and D1's array of numbers both represent a BLOB.
      if (!(value instanceof Uint8Array) && (value instanceof ArrayBuffer || (d1 && Array.isArray(value)))) {
        row[column.name] = coerce("bytes", value, column.name);
      }
      return;
    }
    default: {
      // Other native types already have their final representation.
      return;
    }
  }
};

/**
 * The rows with each value in Reylo's form: a BigInt a number (an error past 2^53), a number past
 * 2^53 in an INTEGER column refused as rounded, a BLOB a Uint8Array, a JSON column parsed and a
 * truth value a boolean. In place, since every driver builds new rows per call. `exact`: the driver
 * read every INTEGER as a BigInt, so a number is a REAL, never a rounded integer. `d1`: an array is
 * D1's BLOB. A row is a plain object on every driver: node:sqlite builds rows with a null
 * prototype, which `assert.deepStrictEqual` and `row.hasOwnProperty` tell apart.
 * @param {unknown[]} rows - The rows the selected driver's query returned.
 * @param {Columns | undefined} columns - The generated query's columns, when known.
 * @param {{ exact?: boolean, d1?: boolean }} options - Representation already selected by the driver.
 * @returns {unknown[]} The original rows with their column values normalized in place.
 */
export function normalize(rows: unknown[], columns: Columns | undefined, { exact = false, d1 = false } = {}): unknown[] {
  if (!Array.isArray(rows)) {return [];}
  if (isEmptyArray(rows)) {return rows;}
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SQLite drivers provide row objects after the array-row adapter has named positional columns.
  const records = rows as Row[];
  // oxlint-disable-next-line typescript/no-non-null-assertion -- Native result rows are dense and the non-empty check guards the first row.
  const outputColumns = columns ? [...columns] : Object.keys(records[0]!).map((name) => [name, "unknown"] as const);
  const plans = outputColumns.map(([name, kind]) => plan(name, kind, exact));
  // oxlint-disable-next-line rules/no-for-loops -- Retain the driver's iterator and update its rows without copying the result array.
  for (const row of records) {
    if (matchesNull(Object.getPrototypeOf(row))) {Object.setPrototypeOf(row, Object.prototype);}
    plans.forEach((column) => {normalizeColumn(row, column, d1);});
  }
  return rows;
}
