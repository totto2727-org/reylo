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
import type { Columns } from "./values.ts";
import { hasFunctionType, matchesUndefined } from "./native-predicates.ts";

import { normalize } from "./decode-sqlite-values.ts";

export { normalize } from "./decode-sqlite-values.ts";

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
