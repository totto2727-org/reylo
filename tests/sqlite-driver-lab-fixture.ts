// oxlint-disable-next-line rules/no-node-imports -- Assert that the optional driver package loaded the expected exports.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The driver availability check uses the independent lab installation.
import { access } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve optional native packages as the installed lab would.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- Resolve paths with the host filesystem's conventions.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Import native ESM drivers from their resolved URLs.
import { pathToFileURL } from "node:url";
import type { LibsqlClient, Sqlite3Client, SqlitePromiseClient, SyncSqliteClient, TursoClient } from "#reylo-source/execute.ts";
import { isRecord, hasFunctionType } from "#reylo-source/native-predicates.ts";
import { DRIVERS, closeSessions } from "./helpers.ts";
import { importBuiltSqliteQuery, withProject } from "./sqlite-project-fixture.ts";

const require = createRequire(path.join(DRIVERS, "package.json"));

const skipLab = async (): Promise<false | string> => {
  try {
    await access(path.join(DRIVERS, "better-sqlite3"));
    return false;
  } catch {
    return "lab/drivers is not installed";
  }
};

export const representationOptions = { skip: await skipLab(), timeout: 60_000 };

export type SqliteQuery = Awaited<ReturnType<typeof importBuiltSqliteQuery>>;
type TestStatement = ReturnType<SyncSqliteClient["prepare"]> & {
  get: () => Record<string, unknown>;
};
interface TestSyncClient {
  close: () => void;
  defaultSafeIntegers: (enabled: boolean) => unknown;
  prepare: (sql: string) => TestStatement;
  transaction: <Result>(callback: () => Result) => () => Result;
}
type TestLibsqlClient = LibsqlClient & { close: () => void };
type TestSqlite3 = Sqlite3Client & { close: (callback: (error?: Error | null) => void) => void };
type TestSqlite = SqlitePromiseClient & { close: () => Promise<void> };
type TestTurso = Omit<TursoClient, "prepare"> & {
  close: () => Promise<void>;
  defaultSafeIntegers: (enabled: boolean) => unknown;
  prepare: (sql: string) => { all: (...params: unknown[]) => Promise<unknown[]>; get: () => Promise<Record<string, unknown>> };
  transactionAsync: <Result>(callback: (transaction: TursoClient) => Promise<Result>) => () => Promise<Result>;
};
interface LibsqlAdapter { createClient: (options: { intMode: string; url: string }) => TestLibsqlClient }
interface Sqlite3Adapter { Database: new (file: string) => TestSqlite3 }
interface SqliteAdapter { open: (options: { driver: Sqlite3Adapter["Database"]; filename: string }) => Promise<TestSqlite> }
type SyncAdapter = new (file: string) => TestSyncClient;
interface TursoAdapter { connect: (file: string) => Promise<TestTurso> }

export interface LabDrivers {
  BetterSQLite: SyncAdapter;
  createClient: LibsqlAdapter["createClient"];
  open: SqliteAdapter["open"];
  SQLite3: Sqlite3Adapter["Database"];
}

export const loadLibsql = (): LibsqlAdapter["createClient"] => {
  const libsql: unknown = require("@libsql/client");
  assert.ok(isRecord(libsql) && hasFunctionType(libsql.createClient));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Load the independent lab's installed libSQL client without a root runtime dependency.
  return libsql.createClient as LibsqlAdapter["createClient"];
};

export const loadDrivers = (): LabDrivers => {
  const betterSQLite: unknown = require("better-sqlite3");
  const createClient = loadLibsql();
  const sqlite3: unknown = require("sqlite3");
  const sqlite: unknown = require("sqlite");
  assert.ok(hasFunctionType(betterSQLite));
  assert.ok(isRecord(sqlite3) && hasFunctionType(sqlite3.Database));
  assert.ok(isRecord(sqlite) && hasFunctionType(sqlite.open));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- These optional native modules supply the lab's installed driver contracts.
  return { BetterSQLite: betterSQLite, SQLite3: sqlite3.Database, createClient, open: sqlite.open } as LabDrivers;
};

export interface TursoDrivers {
  connect: TursoAdapter["connect"];
  TursoCompat: SyncAdapter;
}

export const loadTurso = async (): Promise<TursoDrivers> => {
  const driver: unknown = await import(pathToFileURL(require.resolve("@tursodatabase/database")).href);
  const compat: unknown = await import(pathToFileURL(require.resolve("@tursodatabase/database/compat")).href);
  assert.ok(isRecord(driver) && hasFunctionType(driver.connect));
  assert.ok(isRecord(compat) && hasFunctionType(compat.Database));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The optional Turso lab packages supply these native contracts.
  const connect = driver.connect as TursoAdapter["connect"];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The compat package supplies the native synchronous constructor.
  return { TursoCompat: compat.Database as SyncAdapter, connect: connect.bind(driver) };
};

export interface DriverLabProject {
  file: string;
  root: string;
}

export const withLabProject = async (
  schema: string,
  check: (project: DriverLabProject) => Promise<void>,
): Promise<void> => {
  await withProject(schema, async ({ database, root }) => {
    database.close();
    await check({ file: path.join(root, "app.db"), root });
  });
};

export const built = async (root: string, name: string, sql: string): Promise<SqliteQuery> => {
  try {
    return await importBuiltSqliteQuery(root, name, sql);
  } finally {
    await closeSessions();
  }
};

export const closeSQLite3 = async (client: TestSqlite3): Promise<void> => {
  const closed = Promise.withResolvers<boolean>();
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- sqlite3 provides a callback-only close operation.
  client.close((error) => {
    if (error) {closed.reject(error);}
    else {closed.resolve(true);}
  });
  await closed.promise;
};

// A plain comparison preserves row data without requiring a driver's row or Buffer prototype.
export const plain = (value: unknown): unknown => {
  if (value instanceof Date) {throw new assert.AssertionError({ message: `a Date in Reylo's rows: ${value.toISOString()}` });}
  if (value instanceof Uint8Array) {return { bytes: [...value] };}
  if (Array.isArray(value)) {return value.map((element) => plain(element));}
  if (isRecord(value)) {return Object.fromEntries(Object.entries(value).map(([key, element]) => [key, plain(element)]));}
  return value;
};
