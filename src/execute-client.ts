import { isDuckdb } from "./decode-duckdb.ts";
import type { Dialect } from "./execute-types.ts";
import { hasFunctionType, hasObjectType, matchesNull, matchesNullish } from "./native-predicates.ts";

export type ClientMembers = Record<string, unknown>;
export type DriverRows = PromiseLike<unknown[]>;
export interface BunProtocol { unsafe: (text: string, params: unknown[]) => DriverRows }

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- A runtime member check selects the native driver protocol specified by the caller.
export const inspectClient = <Protocol = object>(client: unknown): ClientMembers & Protocol =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Inspect native members and describe the calling protocol selected for their receiver.
  client as ClientMembers & Protocol;

// A SQLite-backed Durable Object's `ctx.storage.sql`: exec() and databaseSize, and no prepare().
// Sqlite3's Database has exec() too, beside all().
export const isDurableObjectSql = function isDurableObjectSql(client: ClientMembers | null | undefined): boolean {
  return !matchesNullish(client) && hasFunctionType(client.exec) && !hasFunctionType(client.prepare) && !hasFunctionType(client.all) && "databaseSize" in client;
};

/**
 * The driver client a Drizzle database, transaction or savepoint runs on, which its session
 * keeps on `session.client` (the pool for a database, the transaction's own connection inside
 * one), or on `session.tx` inside a libSQL transaction, whose `client` stays the base client;
 * any other client as it is.
 *
 * @param {ClientMembers} currentClient - The supplied native client or Drizzle wrapper.
 * @returns {ClientMembers} The native receiver of the statement, preserving its transaction connection.
 */
export const underneath = function underneath(currentClient: ClientMembers): ClientMembers {
  const session = !matchesNullish(currentClient) && hasObjectType(currentClient) && hasFunctionType(currentClient.select) ? currentClient.session : undefined;
  if (matchesNullish(session) || !hasObjectType(session)) {return currentClient;}
  const sessionMembers = inspectClient(session);
  if (matchesNullish(sessionMembers.dialect)) {return currentClient;}
  const client = inspectClient(sessionMembers.tx ?? sessionMembers.client ?? currentClient);
  // Drizzle-orm/durable-sqlite keeps the Durable Object's storage, whose SQL storage is its sql.
  const sql = inspectClient(client.sql);
  return isDurableObjectSql(sql) ? sql : client;
};

// Turso's promise API (@tursodatabase/database): a Database has connect() and
// MaxWriteReplicationIndex() in every release from 0.4 (0.4 has no all(), so it looked synchronous,
// And from 0.6 its all() took it for sqlite3's, whose callback it never calls); the Transaction
// That transactionAsync() hands its callback (0.7 and later) has all() beside batch(), which
// Sqlite3's database lacks. The compat Database has no connect().
export const isTurso = function isTurso(client: ClientMembers): boolean {
  return hasFunctionType(client.prepare) && ((hasFunctionType(client.connect) && hasFunctionType(client.maxWriteReplicationIndex)) || (hasFunctionType(client.all) && hasFunctionType(client.batch)));
};

// A SQLite client with prepare() whose statements answer at once. D1 (batch()), sqlite3 and
// Sqlite (all() on the database), libSQL (execute()), Bun.sql (unsafe()) and Turso's promise API
// Are asynchronous. Turso's compat Database has batch() as D1 does, and answers at once; its
// MaxWriteReplicationIndex(), which every Database of Turso's has, tells it from D1's. A DuckDB
// Connection has prepare() too, answering through a promise, and runAndReadAll() beside it.
export const isSyncSqlite = function isSyncSqlite(client: ClientMembers | null | undefined): boolean {
  return (
    !matchesNullish(client) &&
    hasFunctionType(client.prepare) &&
    !hasFunctionType(client.runAndReadAll) &&
    (!hasFunctionType(client.batch) || hasFunctionType(client.maxWriteReplicationIndex)) &&
    !hasFunctionType(client.all) &&
    !hasFunctionType(client.execute) &&
    !hasFunctionType(client.unsafe) &&
    !isTurso(client)
  );
};

// Slonik's pool, connections, transactions and savepoints, which have query() as pg's do but take
// Only the queries its sql tag builds (src/decode.ts, `slonik`).
export const isSlonik = function (client: ClientMembers): boolean {
  return hasFunctionType(client.maybeOneFirst) && hasFunctionType(client.anyFirst);
};

const accepted: Record<Dialect, string> = {
  duckdb: "runAndReadAll(sql, values) as on @duckdb/node-api's DuckDBConnection",
  mysql: "execute(text, values) as on mysql2 and PlanetScale; query(text, values) as on mariadb's pool or connection, from its promise or callback API; unsafe(text, values) as on Bun.sql; a mysql2 callback pool or connection; or a Drizzle database over one of them",
  postgres: "query(text, values) as on pg, PGlite, Neon and pg-promise; unsafe(text, values) as on postgres.js and Bun.sql; Neon's neon() function; a Slonik pool, connection or transaction; or a Drizzle database over one of them",
  sqlite: "prepare(sql) as on better-sqlite3, node:sqlite, bun:sqlite, Turso's @tursodatabase/database and Cloudflare D1; exec(sql, ...values) as on a Durable Object's ctx.storage.sql; execute({ sql, args }) as on @libsql/client; all(sql, params) as on sqlite3 and sqlite; unsafe(text, values) as on Bun.sql; or a Drizzle database over one of them",
};

const MAX_DRIVER_METHODS_IN_DIAGNOSTIC = 12;

const clientMethods = (candidate: object): Set<string> => {
  const names = new Set<string>();
  const chain: { current: object | null } = { current: candidate };
  while (chain.current && chain.current !== Object.prototype && chain.current !== Function.prototype) {
    const { current } = chain;
    Iterator.from(Object.getOwnPropertyNames(current)).forEach((key) => {
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (key !== "constructor" && hasFunctionType(property?.value)) {names.add(key);}
    });
    chain.current = Reflect.getPrototypeOf(current);
  }
  return names;
};

const seenClient = (candidate: unknown): string => {
  if (matchesNull(candidate) || (!hasObjectType(candidate) && !hasFunctionType(candidate))) {return String(candidate);}
  const names = clientMethods(candidate);
  if (!names.size) {return "an object with no methods";}
  const preview = Iterator.from(names).take(MAX_DRIVER_METHODS_IN_DIAGNOSTIC).toArray().join(", ");
  const more = names.size > MAX_DRIVER_METHODS_IN_DIAGNOSTIC ? ", ..." : "";
  return `an object with ${preview}${more}`;
};

const ORM_TRANSACTION_HINT = " and does not hand out its transaction's connection: take the transaction from the driver's client instead.";

const ormHint = (client: ClientMembers | undefined): string => {
  // Kysely and Prisma decode raw query values and keep their transaction connections private.
  if (hasFunctionType(client?.selectFrom) && hasFunctionType(client.executeQuery)) {
    const hint = client.isTransaction === true ? ORM_TRANSACTION_HINT : ": pass the pool or database its dialect was made with.";
    return ` Kysely decodes the values of its queries itself${hint}`;
  }
  if (hasFunctionType(client?.$queryRawUnsafe)) {
    const hint = hasFunctionType(client.$transaction) ? ": pass a client of your database's driver, such as the pool its driver adapter was made with." : ORM_TRANSACTION_HINT;
    return ` Prisma decodes the values of its queries itself${hint}`;
  }
  return "";
};

const clientHint = (candidate: unknown, dialect: Dialect): string => {
  const client = matchesNullish(candidate) ? undefined : inspectClient<{ db?: { prepare?: unknown } }>(candidate);
  if (dialect !== "duckdb" && isDuckdb(inspectClient(candidate))) {
    return ` It is a DuckDB connection, and the statement is typed for ${dialect}: set the project's URL to the DuckDB database (duckdb:./app.duckdb).`;
  }
  // Node:sqlite's tag store keeps its native database on db.
  if (hasFunctionType(client?.db?.prepare)) {return " A tag store is not a client: pass its database, store.db.";}
  return ormHint(client);
};

export const unsupported = (candidate: unknown, dialect: Dialect): TypeError => {
  const seen = seenClient(candidate);
  const hint = clientHint(candidate, dialect);
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native TypeError for unsupported clients without loading Effect.
  return new TypeError(`reylo cannot run a ${dialect} statement on ${seen}. It takes a client with ${accepted[dialect]}.${hint}`);
};
