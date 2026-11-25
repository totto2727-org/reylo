import { refusedLogin } from "./connection.ts";
import { duckdbDatabase } from "./duckdb.ts";
import { AnswerCache, MissingEngine } from "./engine.ts";
import type { Analysis, Connection, Diagnostic, Engine } from "./engine.ts";
import { duckdbPath, hclPath, sqlitePath } from "./project.ts";
import type { ResolvedProject } from "./project.ts";
import type { SqliteDriver } from "./sqlite-drivers.ts";
import { matchesNullish, matchesUndefined } from "./native-predicates.ts";

import type { ConnectionOwner } from "./analysis-connection-owner.ts";
import type { Outcome } from "./analysis-results.ts";

export interface AnalysisConnection {
  analyze: (sql: string) => Promise<Analysis>;
  close: () => Promise<void>;
  drivers?: SqliteDriver[];
  forget: () => Promise<void>;
  query: (sql: string, params: unknown[]) => Promise<unknown[][]>;
}

const openDuckDb = (engine: Engine, root: string, url: string): AnalysisConnection => {
  const database = duckdbDatabase(duckdbPath(url, root), root);
  const cache = new AnswerCache();
  return {
    analyze: async (sql) => database.run(async (io) => engine.analyze(sql, "duckdb", io, cache)),
    close: async () => {
      // DuckDB opens and closes its file around each operation.
    },
    // oxlint-disable-next-line typescript/require-await -- The connection contract is asynchronous and this backend's cache clear is synchronous.
    forget: async () => {
      cache.clear();
    },
    query: async (text, params) => database.run(async (io) => io.query(text, params)),
  };
};

const openDrivers = async (root: string, target: string, connection: Connection): Promise<SqliteDriver[]> => {
  try {
    const { openProjectDrivers } = await import("./sqlite-drivers.ts");
    return await openProjectDrivers(root, target);
  } catch (error) {
    await connection.close();
    throw error;
  }
};

const closeDriver = async (driver: SqliteDriver): Promise<void> => {
  await driver.close().catch(() => {
    // Release the engine connection even when a project driver rejects its close.
  });
};

const openServer = async (engine: Engine, { dialect, root }: ResolvedProject, url: string): Promise<AnalysisConnection> => {
  const target = dialect === "sqlite" ? sqlitePath(url, root) : url;
  const connection = await engine.open(target);
  const drivers = dialect === "sqlite" ? await openDrivers(root, target, connection) : undefined;
  return {
    analyze: async (sql) => connection.analyze(sql),
    close: async () => {
      await Promise.all((drivers ?? []).map(async (driver) => closeDriver(driver)));
      await connection.close();
    },
    ...(drivers && { drivers }),
    forget: async () => connection.forget(),
    query: async (text, params) => connection.query(text, params),
  };
};

export const openAnalysisConnection = async (engine: Engine | MissingEngine, project: ResolvedProject, url: string): Promise<AnalysisConnection> => {
  if (engine instanceof MissingEngine) {
    throw engine;
  }
  const { dialect, root } = project;
  const source = hclPath(url, root);
  if (!matchesUndefined(source)) {
    const { hclCatalog } = await import("./hcl.ts");
    return hclCatalog(source, engine);
  }
  if (dialect === "duckdb") {
    return openDuckDb(engine, root, url);
  }
  return openServer(engine, project, url);
};

export const closeAnalysisConnection = async (pending: Promise<AnalysisConnection>): Promise<void> => {
  try {
    const connection = await pending;
    await connection.close();
  } catch {
    // Release is best effort, including when the connection never opened.
  }
};

export const getOpenConnection = async (
  pending: Promise<AnalysisConnection>,
): Promise<AnalysisConnection | undefined> => {
  try {
    return await pending;
  } catch {
    return undefined;
  }
};

const awaitBackground = async (pending: Promise<unknown>): Promise<void> => {
  try {
    await pending;
  } catch {
    // Observe the rejection while its owner handles it, or when cleanup is best effort.
  }
};

export const settleInBackground = (pending: Promise<unknown>): void => {
  // oxlint-disable-next-line eslint/no-void -- The detached observer handles rejection without replacing or delaying the original operation.
  void awaitBackground(pending);
};

export const withLoginRetry = (
  first: AnalysisConnection,
  reopen: (cause: unknown) => Promise<AnalysisConnection>,
): AnalysisConnection => {
  const state = { current: Promise.resolve(first) };

  const rotate = async (connection: AnalysisConnection, cause: unknown): Promise<AnalysisConnection> => {
    await connection.close().catch(() => {
      // A refused connection may already be closed.
    });
    return reopen(cause);
  };

  const call = async <Result>(operation: (connection: AnalysisConnection) => Promise<Result>): Promise<Result> => {
    const used = state.current;
    const connection = await used;
    try {
      return await operation(connection);
    } catch (error) {
      if (state.current === used) {
        if (!refusedLogin(error)) {
          throw error;
        }
        // Calls refused by the same connection await the same replacement.
        state.current = rotate(connection, error);
        settleInBackground(state.current);
      }
      return operation(await state.current);
    }
  };

  const close = async (): Promise<void> => {
    const connection = await getOpenConnection(state.current);
    if (!matchesUndefined(connection)) {
      await connection.close();
    }
  };

  return {
    analyze: async (sql) => call(async (connection) => connection.analyze(sql)),
    close,
    ...(first.drivers && { drivers: first.drivers }),
    forget: async () => call(async (connection) => connection.forget()),
    query: async (text, params) => call(async (connection) => connection.query(text, params)),
  };
};

const PROJECT_DRIVER_REFUSAL = 6;

const firstDriverRefusal = async (sql: string, analysis: Analysis, drivers: ArrayIterator<SqliteDriver>): Promise<Diagnostic | undefined> => {
  const { done, value: driver } = drivers.next();
  if (done === true) {
    return undefined;
  }
  const refusal = await driver.refuses(analysis.rewritten.sql, analysis.rewritten.order.length);
  if (matchesUndefined(refusal)) {
    return firstDriverRefusal(sql, analysis, drivers);
  }
  const { placeRefusal } = await import("./sqlite-drivers.ts");
  const { start, length } = placeRefusal(sql, refusal);
  const message = driver.says(refusal);
  // oxlint-disable-next-line eslint/sort-keys -- Keep the analysis diagnostic in its existing wire order.
  return { message, start, length, code: PROJECT_DRIVER_REFUSAL };
};

interface DriverCheck {
  connections: ConnectionOwner;
  schema: string | null | undefined;
}

// An idle connection can reopen for driver checks. The project's drivers are never cached.
export const applyProjectDrivers = async (sql: string, outcome: Extract<Outcome, { ok: true }>, { connections, schema }: DriverCheck): Promise<Outcome> => {
  const { analysis } = outcome;
  if (analysis.diagnostics.length || matchesNullish(schema)) {
    return outcome;
  }
  const io = await getOpenConnection(connections.get());
  const drivers = (io?.drivers ?? []).values();
  const diagnostic = await firstDriverRefusal(sql, analysis, drivers);
  return matchesUndefined(diagnostic) ? outcome : { ...outcome, analysis: { ...analysis, diagnostics: [diagnostic] } };
};
