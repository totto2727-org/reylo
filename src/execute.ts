// Execute a compiled statement against a caller-supplied native driver.
import { isDuckdb } from "./decode-duckdb.ts";
import { runDurableObject, runSyncSqlite } from "./decode-sqlite.ts";
import { inspectClient, isDurableObjectSql, isSyncSqlite, underneath, unsupported } from "./execute-client.ts";
import type { ClientMembers } from "./execute-client.ts";
import { executeDialect } from "./execute-drivers.ts";
import { checkParams, durableObjectValues } from "./execute-parameters.ts";
import { statement } from "./execute-statement.ts";
import type { ClientFor, Dialect, ParamsInput, QueryModule, SyncClientFor } from "./execute-types.ts";
import { differences, due, passed, staleError } from "./fresh.ts";
import type { Fresh } from "./fresh.ts";
import { hasFunctionType, hasObjectType, matchesNullish } from "./native-predicates.ts";

export type {
  BunSqlClient,
  CallableClient,
  ClientFor,
  D1Client,
  Dialect,
  DrizzleDatabase,
  DrizzleMysqlTransaction,
  DrizzlePgTransaction,
  DrizzleSqliteTransaction,
  DrizzleSyncSqliteTransaction,
  DuckdbClient,
  DurableObjectSql,
  DurableObjectStorage,
  Inputs,
  LibsqlClient,
  MariadbCallbackClient,
  MariadbClient,
  Mysql2CallbackClient,
  MysqlClient,
  MysqlExecuteClient,
  NeonHttpClient,
  ParamsInput,
  PgQueryClient,
  PostgresClient,
  QueryModule,
  SlonikClient,
  Sqlite3Client,
  SqliteClient,
  SqlitePromiseClient,
  SyncClientFor,
  SyncSqliteClient,
  TursoClient,
  UnsafeClient,
} from "./execute-types.ts";

export { arrayLiteral } from "./execute-postgres.ts";
export { compile, rawStatement, sentText } from "./execute-statement.ts";

const verifyFreshness = (query: QueryModule, fresh: Fresh, rows: unknown[] | undefined): void => {
  const changes = (rows && differences(fresh, rows, query.dialect)) ?? [];
  if (changes.length) {throw staleError(query.source, changes);}
  passed(query);
};

const readSqliteCatalog = (client: ClientMembers, fresh: Fresh): unknown[] | undefined => {
  try {
    return isDurableObjectSql(client)
      ? inspectClient<{ exec: (sql: string) => { toArray: () => unknown[] } }>(client).exec(fresh.query).toArray()
      : inspectClient<{ prepare: (sql: string) => { all: () => unknown[] } }>(client).prepare(fresh.query).all();
  } catch {
    // The caller's role can lack catalog access. It can still run the actual query.
    return undefined;
  }
};

const executeSyncSqlite = function executeSyncSqlite(client: ClientMembers, query: QueryModule, params: ParamsInput): unknown[] | Promise<unknown[]> {
  checkParams(query, params);
  const { fresh } = query;
  if (fresh && due(query)) {
    verifyFreshness(query, fresh, readSqliteCatalog(client, fresh));
  }

  const { text, values, names } = statement(query, params);
  if (isDurableObjectSql(client)) {return runDurableObject(client, text, durableObjectValues(query, names, values), query.columns);}
  return runSyncSqlite(client, text, values, query.columns);
};

const refuseSyncClient = (reason: string): TypeError =>
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native TypeError of the synchronous SQLite API without loading Effect.
  new TypeError(`runSync takes a synchronous SQLite client (better-sqlite3, node:sqlite, bun:sqlite, the Database of @tursodatabase/database/compat or a Durable Object's ctx.storage.sql); ${reason}. run takes every client.`);

/**
 * The synchronous path alone, for `runSync`: any other client is refused before anything runs.
 *
 * @param {SyncClientFor<D>} client - The synchronous SQLite client or transaction.
 * @param {QueryModule<D>} query - The module with the SQLite statement.
 * @param {ParamsInput} params - The values keyed by parameter name or position.
 * @returns {unknown[]} The decoded result rows, or an empty array if the statement returns none.
 */
export const executeSync = function executeSync<D extends Dialect>(client: SyncClientFor<D>, query: QueryModule<D>, params: ParamsInput = {}): unknown[] {
  const currentClient = underneath(inspectClient(client));
  if (query.dialect !== "sqlite") {throw refuseSyncClient(`a ${query.dialect} statement has none`);}
  if (!isSyncSqlite(currentClient) && !isDurableObjectSql(currentClient)) {throw refuseSyncClient("this client answers through a promise");}
  const rows = executeSyncSqlite(currentClient, query, params);
  if (Array.isArray(rows)) {return rows;}
  // oxlint-disable-next-line promise/prefer-await-to-then -- This synchronous API consumes the incompatible driver's rejection before throwing its own TypeError.
  rows.catch(() => {
    // The synchronous TypeError below already reports the incompatible driver.
  });
  throw refuseSyncClient("this client's statement answered with a promise");
};

const readAsyncCatalog = async (
  query: QueryModule,
  fresh: Fresh,
  run: (probe: QueryModule) => Promise<unknown[]>,
): Promise<unknown[] | undefined> => {
  try {
    return await run({ dialect: query.dialect, order: [], params: [], sql: fresh.query, text: fresh.query });
  } catch {
    // The caller's role can lack catalog access. It can still run the actual query.
    return undefined;
  }
};

const executeAsync = async function executeAsync(client: ClientMembers | null | undefined, query: QueryModule, params: ParamsInput): Promise<unknown[]> {
  if (matchesNullish(client) || (!hasObjectType(client) && !hasFunctionType(client))) {throw unsupported(client, query.dialect);}
  // A DuckDB connection has prepare() as SQLite's drivers do, and runs no other database's statement.
  if (query.dialect !== "duckdb" && isDuckdb(client)) {throw unsupported(client, query.dialect);}
  checkParams(query, params);
  // The catalog facts the statement relied on, read again through the same client.
  if (query.fresh && due(query)) {
    const { fresh } = query;
    const rows = await readAsyncCatalog(query, fresh, async (probe) => executeAsync(client, probe, {}));
    verifyFreshness(query, fresh, rows);
  }
  return executeDialect(client, query, statement(query, params));
};

/**
 * Runs the statement and returns its rows (an empty array for a statement that returns none).
 * On a synchronous SQLite client the rows come back at once and an error is thrown; on every
 * other client they come back as a promise, which rejects with the driver's own error.
 *
 * @param {ClientFor<D>} client - The native driver client, connection or transaction.
 * @param {QueryModule<D>} query - The module with the statement and its metadata.
 * @param {ParamsInput} params - The values keyed by parameter name or position.
 * @returns {unknown[] | Promise<unknown[]>} The decoded rows or a promise that resolves to them.
 */
export const execute = function execute<D extends Dialect>(
  client: ClientFor<D>,
  query: QueryModule<D>,
  params: ParamsInput = {},
): unknown[] | Promise<unknown[]> {
  const currentClient = underneath(inspectClient(client));
  if (query.dialect === "sqlite" && (isSyncSqlite(currentClient) || isDurableObjectSql(currentClient))) {return executeSyncSqlite(currentClient, query, params);}
  return executeAsync(currentClient, query, params);
};
