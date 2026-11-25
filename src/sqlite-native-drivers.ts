// oxlint-disable-next-line rules/no-node-imports -- Resolve the optional libsql dependency from its consumer package.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- Convert the installed Turso compat package path for Node's ESM loader.
import { pathToFileURL } from "node:url";
import { nativeErrorText } from "./native-error-text.ts";
import { matchesUndefined } from "./native-predicates.ts";
import type { SqliteDriver } from "./sqlite-drivers.ts";

export type SqliteDriverOpener = (require: NodeJS.Require, path: string) => Promise<SqliteDriver>;

const VERSION_QUERY = "select sqlite_version() as v";

// Better-sqlite3's synchronous API, also implemented by libsql and Turso's compat module.
interface SyncDatabase {
  close: () => void;
  prepare: {
    (sql: typeof VERSION_QUERY): { get: () => { v: string } };
    (sql: string): { get: () => unknown };
  };
}

type SyncConstructor = new (path: string, options: { fileMustExist?: boolean; readonly: boolean }) => SyncDatabase;

const reportedDriver = (name: string, version: string, { close, refuses }: Pick<SqliteDriver, "close" | "refuses">): SqliteDriver => (
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the existing native driver's field order.
  { name, says: (refusal) => `${name} runs SQLite ${version}, which refuses this statement: ${refusal}`, refuses, close }
);

const syncDriver = (name: string, database: SyncDatabase): SqliteDriver => {
  const { v: version } = database.prepare(VERSION_QUERY).get();
  return reportedDriver(name, version, {
    // oxlint-disable-next-line typescript/require-await -- Keep the driver's promise contract while closing the synchronous native connection immediately.
    async close() {
      database.close();
    },
    // oxlint-disable-next-line typescript/require-await -- Keep the driver's promise contract while preparing synchronously in the installed native engine.
    async refuses(sql) {
      try {
        database.prepare(sql);
      } catch (error) {
        return nativeErrorText(error, "message");
      }
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Resolve the native driver's no-refusal sentinel explicitly alongside its string result.
      return undefined;
    },
  });
};

interface SyncPackage {
  fileMustExist?: boolean;
  importName?: string;
  name: string;
  relativeTo?: string;
}

const syncEntry = ({ fileMustExist = false, name, importName = name, relativeTo }: SyncPackage): [string, SqliteDriverOpener] => {
  // oxlint-disable-next-line typescript/require-await -- The optional module opens synchronously, and all driver openers expose a Promise.
  const open = async (require: NodeJS.Require, path: string): Promise<SqliteDriver> => {
    const load = matchesUndefined(relativeTo) ? require : createRequire(require.resolve(relativeTo));
    const loaded: unknown = load(importName);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The listed optional CommonJS packages export the native SQLite constructor.
    const Database = loaded as SyncConstructor;
    return syncDriver(name, new Database(path, { readonly: true, ...(fileMustExist ? { fileMustExist: true } : {}) }));
  };
  return [name, open];
};

interface Sqlite3Database {
  close: (callback: () => void) => void;
  get: (sql: typeof VERSION_QUERY, callback: (error: Error | null, row: { v: string }) => void) => void;
  prepare: (sql: string, callback: (error: Error | null) => void) => { finalize: () => void };
}

interface Sqlite3Module {
  Database: new (path: string, mode: number, callback: (error: Error | null) => void) => Sqlite3Database;
  OPEN_READONLY: number;
}

const sqlite3Version = async (database: Sqlite3Database): Promise<string> => {
  const { promise, reject, resolve } = Promise.withResolvers<string>();
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Node-sqlite3 delivers its version row through this native callback.
  database.get(VERSION_QUERY, (error, row) => {
    if (error) {reject(error);}
    else {resolve(row.v);}
  });
  return promise;
};

const sqlite3Close = async (database: Sqlite3Database): Promise<void> => {
  const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
  database.close(() => {resolve();});
  return promise;
};

const sqlite3Refuses = async (database: Sqlite3Database, sql: string): Promise<string | undefined> => {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Node-sqlite3 reports preparation and finalization through its native callback API.
  const statement = database.prepare(sql, (error) => {
    if (!error) {statement.finalize();}
    // Node-sqlite3 writes the result code before SQLite's message.
    resolve(error ? error.message.replace(/^SQLITE_\w+: /u, "") : undefined);
  });
  return promise;
};

const openSqlite3 = async (require: NodeJS.Require, path: string): Promise<SqliteDriver> => {
  const exported: unknown = require("sqlite3");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The optional sqlite3 module exposes this native callback API.
  const sqlite3 = exported as Sqlite3Module;
  const opened = Promise.withResolvers<Sqlite3Database>();
  const database = new sqlite3.Database(path, sqlite3.OPEN_READONLY, (error) => {
    if (error) {opened.reject(error);}
    else {opened.resolve(database);}
  });
  const ready = await opened.promise;
  const version = await sqlite3Version(ready);
  return reportedDriver("sqlite3", version, {
    close: async () => sqlite3Close(ready),
    refuses: async (sql) => sqlite3Refuses(ready, sql),
  });
};

const openTurso = async (require: NodeJS.Require, path: string): Promise<SqliteDriver> => {
  const module: unknown = await import(pathToFileURL(require.resolve("@tursodatabase/database/compat")).href);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Turso's optional compat module exposes the synchronous SQLite constructor.
  const { Database } = module as { Database: SyncConstructor };
  return syncDriver("@tursodatabase/database", new Database(path, { readonly: true }));
};

export const nativeDrivers: [string, SqliteDriverOpener][] = [
  syncEntry({ fileMustExist: true, name: "better-sqlite3" }),
  // @libsql/client opens SQLite files through its own libsql dependency.
  syncEntry({ importName: "libsql", name: "@libsql/client", relativeTo: "@libsql/client" }),
  syncEntry({ name: "libsql" }),
  ["sqlite3", openSqlite3],
  ["@tursodatabase/database", openTurso],
];
