// DuckDB analysis uses the project's optional driver in read-only mode. This fork retains the
// Shared adapter, while its published engine tooling supports SQLite and static Atlas HCL.
import { Unreachable } from "./connection.ts";
import { nodeApi } from "./duckdb-api.ts";
import type { DbConnection, Instance, NodeApi } from "./duckdb-api.ts";
import { copyOf } from "./duckdb-copy.ts";
import { describe } from "./duckdb-describe.ts";
import type { EngineIo } from "./engine-core.ts";
import { nativeErrorText } from "./native-error-text.ts";
import { matchesUndefined, nonemptyText } from "./native-predicates.ts";

export { NoDuckdbDriver } from "./duckdb-api.ts";

const opened = (error: unknown): never => {
  // oxlint-disable-next-line rules/no-instanceof-error -- Keep the optional driver's native Error as the cause without importing Effect.
  if (error instanceof Error) {throw new Unreachable(error);}
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native wrapper for a driver that throws a non-Error value.
  throw new Unreachable(new Error(String(error)));
};

const LOCKED = /Could not set lock on file/u;
const HELD_ON_WINDOWS = /File is already open in\s+(?<holder>.*?\(PID \d+\))/u;

type Options = Record<string, string>;

const openCopy = async (api: NodeApi, filename: string, options: Options): Promise<Instance> => {
  try {
    return await api.DuckDBInstance.create(copyOf(filename), options);
  } catch {
    // A snapshot can catch a writer halfway through a WAL update. Retry with a fresh copy.
    try {
      return await api.DuckDBInstance.create(copyOf(filename, true), options);
    } catch (error) {
      return opened(error);
    }
  }
};

const openDatabase = async (api: NodeApi, filename: string, options: Options): Promise<Instance> => {
  const pending = api.DuckDBInstance.create(filename, options);
  try {
    return await pending;
  } catch (error) {
    const message = nativeErrorText(error, "message");
    if (LOCKED.test(message)) {return openCopy(api, filename, options);}
    const holder = nonemptyText(HELD_ON_WINDOWS.exec(message)?.groups?.holder);
    if (!matchesUndefined(holder)) {
      // oxlint-disable-next-line rules/require-tagged-error -- Return the original native lock error for a reader on Windows.
      return opened(new Error(`${holder} holds it for writing, and on Windows no other process can read it meanwhile, not even to copy it: type-check while that process is stopped`));
    }
    return opened(error);
  }
};

const connect = async (instance: Instance): Promise<DbConnection> => {
  const pending = instance.connect();
  try {
    return await pending;
  } catch (error) {
    return opened(error);
  }
};

type Work<Result> = (io: EngineIo) => Promise<Result>;
interface DuckdbDatabase {
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the adapter's generic native execution method signature.
  run<Result>(work: Work<Result>): Promise<Result>;
}

const ioFor = (api: NodeApi, connection: DbConnection): EngineIo => ({
  describe: async (sql) => describe(api, connection, sql),
  async query(sql, params) {
    const rows = await connection.runAndReadAll(sql, params);
    return rows.getRowsJson();
  },
});

const connected = async <Result>(api: NodeApi, instance: Instance, work: Work<Result>): Promise<Result> => {
  const connection = await connect(instance);
  try {
    return await work(ioFor(api, connection));
  } finally {
    // oxlint-disable-next-line node/no-sync -- Close the native connection before releasing its database instance.
    connection.closeSync();
  }
};

/**
 * Supply the retained DuckDB analysis adapter using the project's installed native driver.
 * @param {string} filename - The database path or `:memory:`.
 * @param {string} root - The root used to resolve the driver and read relative data paths.
 * @returns {DuckdbDatabase} The per-analysis native database boundary.
 */
export const duckdbDatabase = function duckdbDatabase(filename: string, root: string): DuckdbDatabase {
  const api = nodeApi(root);
  return {
    async run(work) {
      const options: Options = { file_search_path: root };
      if (filename !== ":memory:") {options.access_mode = "READ_ONLY";}
      const instance = await openDatabase(api, filename, options);
      try {
        return await connected(api, instance, work);
      } finally {
        // oxlint-disable-next-line node/no-sync -- Release the read-only database handle on every exit from analysis.
        instance.closeSync();
      }
    },
  };
};
