import { bunRows, neonCallable, postgresJs, queryPostgres, slonik } from "./decode.ts";
import { isDuckdb, runDuckdb } from "./decode-duckdb.ts";
import { mariadb, mysql2, planetscale } from "./decode-mysql.ts";
import { normalize, runTurso } from "./decode-sqlite.ts";
import { inspectClient, isSlonik, isTurso, unsupported } from "./execute-client.ts";
import type { BunProtocol, ClientMembers, DriverRows } from "./execute-client.ts";
import { isJsonValue, isTime, jsonText, jsonValue, numberOrDigits, parameterName } from "./execute-parameters.ts";
import type { EngineType } from "./execute-parameters.ts";
import { asByteaHex, postgresTypedArray, slonikParam } from "./execute-postgres.ts";
import type { BoundStatement } from "./execute-statement.ts";
import type { DuckdbClient, QueryModule } from "./execute-types.ts";
import { hasFunctionType, matchesString, matchesUndefined } from "./native-predicates.ts";

type Columns = NonNullable<QueryModule["columns"]>;

// A binary parameter is typed Uint8Array, and every driver binds one as it is (pg-promise too,
// Since it gets { text, values }) but two (lab/driver-matrix, S1c). mariadb writes any value
// That is not a Buffer as JSON, so a plain Uint8Array (TextEncoder's, getRandomValues') arrived
// As the text {"0":1,"1":2,"2":255}: it gets a Buffer over the same memory, where a Buffer
// Exists (not in every Worker). Neon's neon() before 0.10 sends a Buffer as JSON as well, so it
// Gets Postgres's hex form, `\x0102ff`, which 0.10 and later send for a Buffer themselves.
const asBuffer = function asBuffer(binaryValue: unknown): unknown {
  // Named structurally, so that a project without Node's types can type-check the module.
  const NodeBuffer = (globalThis as { Buffer?: { isBuffer: (candidate: unknown) => boolean; from: (buffer: ArrayBufferLike, offset: number, length: number) => Uint8Array } }).Buffer;
  return binaryValue instanceof Uint8Array && !matchesUndefined(NodeBuffer) && !NodeBuffer.isBuffer(binaryValue) ? NodeBuffer.from(binaryValue.buffer, binaryValue.byteOffset, binaryValue.byteLength) : binaryValue;
};

const inputTypeAt = (query: QueryModule, names: Readonly<string[]>, index: number): EngineType | undefined =>
  query.inputs?.[parameterName(names, index)]?.type;

  // Postgres.js reads a string for a date or time parameter through `new Date(x)` and binds
  // Its toISOString(), so a timestamp's wall-clock time moved by the app's offset, and
  // `infinity` or a zone name failed with "Invalid time value". Declared `unknown` (705), it
  // Is sent as the text, which the server reads as the parameter's type, as it would an
  // Undeclared one. Bun.sql (commitDistributed()) sends the text and has no typed().
  // A JSON parameter goes to postgres.js as its JSON text declared `unknown` too: its own
  // Serializer would write a value as JSON, but a client Drizzle wraps has that serializer
  // Replaced by one that passes the value through (drizzle-orm/postgres-js), and a
  // Transaction shows neither. Bun.sql serializes the value itself.
const UNKNOWN_POSTGRES_OID = 705;

const executePostgresUnsafe = async (client: ClientMembers, query: QueryModule, bound: BoundStatement): Promise<unknown[]> => {
  const bun = hasFunctionType(client.commitDistributed);
  const asText = hasFunctionType(client.typed) && !bun;
  const postgres = inspectClient<{ typed: (value: unknown, oid: number) => unknown }>(client);
  const mapped = bound.values.map((parameter, index) => {
    if (isJsonValue(query, parameterName(bound.names, index), parameter)) {
      return asText ? postgres.typed(jsonText(parameter), UNKNOWN_POSTGRES_OID) : { toJSON: () => jsonValue(parameter) };
    }
    if (asText && matchesString(parameter) && isTime(inputTypeAt(query, bound.names, index))) {
      return postgres.typed(parameter, UNKNOWN_POSTGRES_OID);
    }
    return parameter;
  });
  return bun
    ? bunRows(await inspectClient<BunProtocol>(client).unsafe(bound.text, mapped), query.columns)
    : postgresJs(client, bound.text, mapped, query.columns);
};

  // A JSON parameter goes to pg's family, PGlite and Neon as its JSON text, and to postgres.js
  // As its JSON text declared `unknown` (below). Bun.sql serializes a value for a JSON
  // Parameter itself, so JSON text would be stored as a JSON string, and it types a boolean,
  // A number or an array of either by its JavaScript type ("cannot cast type boolean to
  // Jsonb"): it gets an object whose toJSON() returns the value, which it binds as JSON and
  // Serializes to exactly its JSON text. So does an unsafe() client without typed().
const postgresJsonBindings = (query: QueryModule, { names, values }: BoundStatement): unknown[] =>
  values.map((parameter, index) => (isJsonValue(query, parameterName(names, index), parameter) ? jsonText(parameter) : parameter));

const executePostgres = async (client: ClientMembers, query: QueryModule, input: BoundStatement): Promise<unknown[]> => {
  // An array for a SQL array parameter goes as its literal text, which the server reads as
  // The parameter's type, written as pg writes it: Bun.sql binds no JavaScript array
  // (`any($1)` failed with "insufficient data left in message"), postgres.js types an
  // Array by its first element ("cannot cast type boolean to boolean[]" for `$1::bool[]`),
  // And the copy of pg inside Neon's Pool and Client threw on a Uint8Array element and
  // Left the connection out of step. Each element of a `jsonb[]` is a JSON value.
  const bound: BoundStatement = { ...input, values: input.values.map((parameter, index) => {
    const type = inputTypeAt(query, input.names, index);
    return Array.isArray(parameter) && type?.kind === "array" ? postgresTypedArray(parameter, type) : parameter;
  }) };
  // Slonik takes only queries built by its SQL tag.
  if (isSlonik(client)) {return slonik(client, bound.text, postgresJsonBindings(query, bound).map((parameter) => slonikParam(parameter)), query.columns);}
  // Neon's template helper also has unsafe(), which builds a fragment without running it.
  if (hasFunctionType(client.query)) {return queryPostgres(client, bound.text, postgresJsonBindings(query, bound), query.columns);}
  if (hasFunctionType(client.unsafe)) {return executePostgresUnsafe(client, query, bound);}
  if (hasFunctionType(client)) {
    return neonCallable(client, bound.text, postgresJsonBindings(query, bound).map((parameter) => asByteaHex(parameter)), query.columns);
  }
  throw unsupported(client, query.dialect);
};

const executeMysql = async (client: ClientMembers, query: QueryModule, { text, values }: BoundStatement): Promise<unknown[]> => {
  if (hasFunctionType(client.unsafe)) {return bunRows(await inspectClient<BunProtocol>(client).unsafe(text, values), query.columns);}
  // Mariadb, checked before execute() because it has one too (returning rows, not a pair).
  // Its callback API (mariadb/callback) answers through the callback and returns a command
  // Object; its promise API returns a promise and ignores the callback.
  if (hasFunctionType(client.batch) && hasFunctionType(client.query)) {return mariadb(client, text, values.map((parameter) => asBuffer(parameter)), query.columns);}
  // Mysql2's callback API: the promise() wrapper runs on the same connection.
  const mysqlClient = hasFunctionType(client.promise)
    ? inspectClient<{ promise: () => ClientMembers }>(client).promise()
    : client;
  if (hasFunctionType(mysqlClient.execute)) {
    // Mysql2 has query() beside execute(); PlanetScale's Connection, Client and transaction do not.
    return hasFunctionType(mysqlClient.query) ? mysql2(mysqlClient, text, values, query.columns) : planetscale(mysqlClient, text, values, query.columns);
  }
  throw unsupported(client, query.dialect);
};

const executeDuckdb = async (client: ClientMembers, query: QueryModule, { text, values, names }: BoundStatement): Promise<unknown[]> => {
  // @duckdb/node-api's DuckDBConnection: each value given its kind by the result's own types (decode-duckdb.ts).
  if (isDuckdb(client)) {return runDuckdb(inspectClient<DuckdbClient>(client), text, values, names.map((_name, index) => inputTypeAt(query, names, index)), query.columns);}
  throw unsupported(client, query.dialect);
};

const sqlite3Bindings = (query: QueryModule, { names, values }: BoundStatement): unknown[] =>
  // The sqlite wrapper uses sqlite3, which otherwise binds a BigInt as NULL.
  values.map((parameter, index) => numberOrDigits(parameter, inputTypeAt(query, names, index), "sqlite3"));

const sqlite3Rows = async (client: ClientMembers, text: string, values: unknown[]): Promise<unknown[]> => {
  type Callback = (error: Error | null, rows: unknown[]) => void;
  const sqlite = inspectClient<{ all: (text: string, values: unknown[], done: Callback) => void }>(client);
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  try {
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- The native sqlite3 method supplies its result through this callback.
    sqlite.all(text, values, (error, rows) => {
      if (error) {reject(error);}
      else {resolve(rows);}
    });
  } catch (error) {
    reject(error);
  }
  return promise;
};

const preparedSqlite = async (client: ClientMembers, { text, values }: BoundStatement, columns: Columns | undefined): Promise<unknown[]> => {
  const prepared = inspectClient<{ prepare: (text: string) => ClientMembers }>(client).prepare(text);
  if (hasFunctionType(prepared.first)) {
    const d1 = inspectClient<{ bind: (...values: unknown[]) => { all: () => PromiseLike<{ results: unknown[] }> } }>(prepared);
    const bound = d1.bind(...values);
    const result = await bound.all();
    return normalize(result.results, columns, { d1: true });
  }
  const preparedStatement = inspectClient<{ all: (...values: unknown[]) => DriverRows }>(prepared);
  return normalize(await preparedStatement.all(...values), columns);
};

const executeSqliteStatements = async (
  client: ClientMembers,
  bound: BoundStatement,
  { columns, query }: { columns: Columns | undefined; query: QueryModule },
): Promise<unknown[]> => {
  if (hasFunctionType(client.getDatabaseInstance)) {
    const sqlite = inspectClient<{ all: (text: string, values: unknown[]) => DriverRows }>(client);
    return normalize(await sqlite.all(bound.text, sqlite3Bindings(query, bound)), columns);
  }
  if (hasFunctionType(client.all) && hasFunctionType(client.exec)) {
    return normalize(await sqlite3Rows(client, bound.text, sqlite3Bindings(query, bound)), columns);
  }
  if (hasFunctionType(client.prepare)) {return preparedSqlite(client, bound, columns);}
  throw unsupported(client, query.dialect);
};

const executeSqlite = async (client: ClientMembers, query: QueryModule, bound: BoundStatement): Promise<unknown[]> => {
  const { columns } = query;
  if (hasFunctionType(client.unsafe)) {
    return normalize(await inspectClient<BunProtocol>(client).unsafe(bound.text, bound.values), columns);
  }
  if (hasFunctionType(client.execute)) {
    const libsql = inspectClient<{ execute: (query: { sql: string; args: unknown[] }) => PromiseLike<{ rows: unknown[] }> }>(client);
    // oxlint-disable-next-line eslint/sort-keys -- Preserve the native libSQL statement's key order.
    const result = await libsql.execute({ sql: bound.text, args: bound.values });
    return normalize(result.rows, columns);
  }
  if (isTurso(client)) {return runTurso(client, bound.text, bound.values, columns);}
  return executeSqliteStatements(client, bound, { columns, query });
};

export const executeDialect = async (client: ClientMembers, query: QueryModule, bound: BoundStatement): Promise<unknown[]> => {
  switch (query.dialect) {
    case "postgres": {return executePostgres(client, query, bound);}
    case "mysql": {return executeMysql(client, query, bound);}
    case "duckdb": {return executeDuckdb(client, query, bound);}
    case "sqlite": {return executeSqlite(client, query, bound);}
    default: {throw unsupported(client, query.dialect);}
  }
};
