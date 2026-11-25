// oxlint-disable-next-line rules/no-node-imports -- Require the native rows and promise paths before inspecting them in the driver tests.
import assert from "node:assert/strict";
import { execute, executeSync } from "#reylo-source/execute.ts";
import type { ClientFor, Dialect, ParamsInput, QueryModule, SyncClientFor } from "#reylo-source/execute.ts";
import { isRecord } from "#reylo-source/native-predicates.ts";
import { promiseDriverStub } from "./helpers.ts";

export const driverMarker = (): void => {
  // The presence of this method identifies the fixture's driver. The method does no work.
};

export const asyncDriverMarker = promiseDriverStub(driverMarker);

/**
 * Exercise Reylo's runtime dispatch with partial native drivers or deliberately invalid inputs.
 * @param {unknown} client - The fixture passed across the native driver boundary.
 * @param {QueryModule<D>} query - The statement and its metadata.
 * @param {unknown} [params] - Parameters to check at runtime.
 * @returns {unknown[] | Promise<unknown[]>} The result in the form returned by the actual dispatcher.
 */
export const executeFixture = <D extends Dialect>(
  client: unknown,
  query: QueryModule<D>,
  params?: unknown,
): unknown[] | Promise<unknown[]> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- These test doubles exercise the dispatcher with partial or invalid native caller shapes.
  execute(client as ClientFor<D>, query, params as ParamsInput);

/**
 * Exercise the synchronous entry point with deliberately untyped test doubles.
 * @param {unknown} client - The fixture passed to synchronous SQLite dispatch.
 * @param {QueryModule<D>} query - The statement and its metadata.
 * @param {ParamsInput} [params] - Parameters for the statement.
 * @returns {unknown[]} The rows from the native dispatch.
 */
export const executeSyncFixture = <D extends Dialect>(
  client: unknown,
  query: QueryModule<D>,
  params?: ParamsInput,
): unknown[] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, node/no-sync -- These fixture clients exercise the native synchronous dispatch boundary directly.
  executeSync(client as SyncClientFor<D>, query, params);

// oxlint-disable-next-line typescript/promise-function-async -- Verify that dispatch itself returns a native Promise without wrapping the result.
export const driverPromise = (result: unknown): Promise<unknown> => {
  assert.ok(result instanceof Promise, "Expected the native asynchronous query path to return a Promise");
  return result;
};

export const driverRow = (value: unknown): Record<string, unknown> => {
  assert.ok(isRecord(value), "Expected a row object from the dispatch fixture");
  return value;
};

export const driverRows = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value), "Expected the synchronous query path to return its rows");
  return value;
};
