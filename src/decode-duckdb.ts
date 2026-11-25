// The run time on DuckDB, over @duckdb/node-api's DuckDBConnection: `runAndReadAll(sql, values)`
// Runs the statement, and each value is given its type's one representation (src/values.ts) by
// The result's own column types, which hold every field of a STRUCT and every element of a LIST:
// A BIGINT or HUGEINT is a BigInt, a DECIMAL its exact text, a DATE `YYYY-MM-DD`, a TIMESTAMP its
// Wall-clock text with `T`, a TIMESTAMPTZ its ISO 8601 instant in UTC, an INTERVAL an ISO 8601
// Duration, a BLOB a Uint8Array, a JSON its value, a LIST an array, a STRUCT an object of its
// Fields, a MAP its entries as `{ key, value }`, and a UNION `{ tag, value }`. A year outside 0000
// To 9999 is written as ISO 8601 extends it (`+010000`, `-000044`), and an infinite date or
// Timestamp as `infinity` or `-infinity`.
//
// Node-api binds a string, a number, a BigInt and a boolean as it is, and DuckDB casts each to its
// Parameter's type, checking its range. A list, a struct, a map or binary data it binds only as
// A value of its own classes with its type said, so the run time builds those with node-api's own
// Constructors, loaded from the app beside the connection: each element a type node-api takes
// From JavaScript (an integer a HUGEINT, a decimal or a date its text), which DuckDB casts in turn.
import { readDuckRows } from "./duckdb-result.ts";
import type { Reader } from "./duckdb-result.ts";
import { nodeApiOf } from "./duckdb-node-api.ts";
import type { EngineType } from "./engine-type.ts";
import type { Columns } from "./values.ts";
import { hasFunctionType, isEmptyArray, matchesNullish, matchesUndefined } from "./native-predicates.ts";

import { bindingsFrom, needsBinding } from "./duckdb-parameters.ts";

export { duckdbInterval } from "./decode-duckdb-time.ts";
export { encodeDuckdb } from "./duckdb-parameters.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- Keep the published structural driver contracts compatible with each driver's own parameter and callback types.
export type DriverValue = any;

/** @duckdb/node-api's DuckDBConnection, a connection of a DuckDBInstance: `run` takes it. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- The published client alias remains structurally assignable to the query dispatcher.
export type DuckdbClient = {
  // oxlint-disable-next-line typescript/method-signature-style -- Keep method assignability for the native driver's parameter overloads.
  runAndReadAll(sql: string, values?: DriverValue, types?: DriverValue): Promise<unknown>;
  // oxlint-disable-next-line typescript/method-signature-style -- Keep the published native client method contract.
  prepare(sql: string): Promise<unknown>;
};

/**
 * Recognizes the native DuckDB connection protocol.
 * @param {Record<string, unknown> | null | undefined} client - A candidate connection.
 * @returns {boolean} Whether it supplies the DuckDB methods.
 */
export const isDuckdb = function isDuckdb(client: Record<string, unknown> | null | undefined): boolean {
  return !matchesNullish(client) && hasFunctionType(client.runAndReadAll) && hasFunctionType(client.prepare) && hasFunctionType(client.run);
};

/**
 * Runs a query with the native constructors belonging to its connection.
 * @param {DuckdbClient} client - The selected DuckDB connection.
 * @param {string} text - The SQL statement.
 * @param {unknown[]} values - The values to bind.
 * @param {(EngineType | undefined)[]} types - The engine type of each parameter, when known.
 * @param {Columns | undefined} columns - The emitted result columns, when known.
 * @returns {Promise<unknown[]>} The decoded rows.
 */
// oxlint-disable-next-line eslint/max-params -- Preserve the positional signature used by the native query dispatcher.
export const runDuckdb = async function runDuckdb(client: DuckdbClient, text: string, values: unknown[], types: (EngineType | undefined)[], columns: Columns | undefined): Promise<unknown[]> {
  const bound = values.some((value) => needsBinding(value))
    ? bindingsFrom(await nodeApiOf(client), values, types)
    : { types: undefined, values };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DuckDB's native runAndReadAll resolves to its result reader.
  const reader = (await client.runAndReadAll(text, bound.values, bound.types)) as Reader;
  if (!matchesUndefined(columns) && isEmptyArray(columns)) {return [];}
  return readDuckRows(reader);
};
