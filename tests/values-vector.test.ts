// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs these driver and binary protocol checks with the native Node test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Compare decoded vectors and exact errors in the native runner.
import assert from "node:assert/strict";
import { execute } from "#reylo-source/execute.ts";
import type { QueryModule } from "#reylo-source/execute.ts";
import type { EngineType } from "#reylo-source/engine-type.ts";
import { renderParamType, renderType } from "#reylo-source/render.ts";
import { coerce, columnKind, DecodeError } from "#reylo-source/values.ts";
import type { Columns } from "#reylo-source/values.ts";
import { forEachFixtureInOrder, promiseDriverStub, requireFixtureValue, SQL_NULL } from "./helpers.ts";
import { asyncDriverMarker, driverPromise, driverRows, executeFixture, scalarFixture } from "./driver-fixtures.ts";
import type { PlanetScaleOptions } from "./driver-fixtures.ts";

const mysql2Vector = (value: number[] | Buffer): { v: number[] | Buffer; vn: null } => ({ v: value, vn: SQL_NULL });

const checkMysql2Vector = async function (floats: number[], bytes: Buffer, query: QueryModule<"mysql">): Promise<void> {
  const fields = [{ columnType: 242, decimals: 0, name: "v" }, { columnType: 242, decimals: 0, name: "vn" }];
  const expected = [{ v: floats, vn: SQL_NULL }];
  await forEachFixtureInOrder([floats, Buffer.from(bytes)], async (value) => {
    const client = { execute: promiseDriverStub(() => [[mysql2Vector(value)], fields]), query: promiseDriverStub(() => [[], []]) };
    assert.deepEqual(await executeFixture(client, query), expected);
  });
};

const checkVectorDrivers = async function (floats: number[], bytes: Buffer): Promise<void> {
  const columns: Columns = [["v", "float[]"], ["vn", "float[]"]];
  const fixtureQuery: QueryModule<"mysql"> = { columns, dialect: "mysql", params: [], sql: "select 1" };
  const expected = [{ v: floats, vn: SQL_NULL }];
  // Mysql2 3.x decodes the floats itself; mariadb and PlanetScale give the bytes.
  await checkMysql2Vector(floats, bytes, fixtureQuery);
  const driver = { batch: promiseDriverStub(() => ({})), query: promiseDriverStub(() => [{ v: Buffer.from(bytes), vn: SQL_NULL }]) };
  const decoded = await execute(driver, fixtureQuery);
  assert.deepEqual([...decoded], expected);
  const planetDriver = {
    execute: promiseDriverStub((_sql: string, __: unknown, options: PlanetScaleOptions) => ({
      rows: [{ v: options.cast({ charset: 63, type: "VECTOR" }, bytes.toString("latin1")), vn: options.cast({ charset: 63, type: "VECTOR" }, SQL_NULL) }],
    })),
  };
  assert.deepEqual(await executeFixture(planetDriver, fixtureQuery), expected);
};

const checkVectorBytes = function (floats: number[], bytes: Buffer): void {
  // A slice of a larger buffer, as a driver's row may be, reads from its own offset.
  const wrapped = Buffer.concat([Buffer.of(9, 9, 9), bytes]);
  assert.deepEqual(coerce("float[]", wrapped.subarray(3), "v"), floats);
  assert.throws(() => coerce("float[]", bytes.subarray(0, 5), "v"), (candidate: unknown) => candidate instanceof DecodeError && /Column "v" is a VECTOR, whose value is 4 bytes per 32-bit float, and holds 5 bytes/u.test(candidate.message));
  // A Postgres float4[] from Bun.sql is a Float32Array, which is not read as bytes.
  assert.deepEqual(coerce("float[]", new Float32Array([1, 2.5]), "v"), [1, 2.5]);
};

const checkVectorBindings = async function (floats: number[], insertQuery: QueryModule<"mysql">): Promise<void> {
  const seen: unknown[][] = [];
  await execute({ execute: promiseDriverStub((_statement: unknown, boundValues?: unknown[]) => {
    seen.push(requireFixtureValue(boundValues));
    return [[], []] as [unknown, unknown];
  }), query: promiseDriverStub(() => [[], []] as [unknown, unknown]) }, insertQuery, { v: floats });
  await execute({ batch: promiseDriverStub(() => []), query: promiseDriverStub((_sql: string, boundValues: unknown) => {
    seen.push(driverRows(boundValues));
    return [];
  }) }, insertQuery, { v: floats });
  await execute({ commitDistributed: asyncDriverMarker, unsafe: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(requireFixtureValue(boundValues));
    return [];
  }) }, insertQuery, { v: floats });
  await executeFixture({ execute: promiseDriverStub((_sql: string, boundValues: unknown[]) => {
    seen.push(boundValues);
    return { rows: [] };
  }) }, insertQuery, { v: floats });
  await execute({ batch: promiseDriverStub(() => ({})), query: promiseDriverStub((_sql: string, boundValues: unknown) => {
    seen.push(driverRows(boundValues));
    return [];
  }) }, insertQuery, { v: SQL_NULL });
  const expected = Array.from({ length: 4 }, () => ["[1,2.5,-3,0.10000000149011612]"]);
  assert.deepEqual(seen, [...expected, [SQL_NULL]]);
};

const checkInvalidVectors = async function (insertQuery: QueryModule<"mysql">): Promise<void> {
  const fake = { execute: promiseDriverStub(() => [[], []]), query: promiseDriverStub(() => [[], []]) };
  await assert.rejects(driverPromise(executeFixture(fake, insertQuery, { v: [1, "2"] })), /^TypeError: Parameter "v" is a VECTOR, an array of finite numbers, and the element at \[1\] is "2"\.$/u);
  await assert.rejects(driverPromise(executeFixture(fake, insertQuery, { v: [1, Number.NaN] })), /the element at \[1\] is NaN/u);
  await assert.rejects(driverPromise(executeFixture(fake, insertQuery, { v: [Infinity] })), /the element at \[0\] is Infinity/u);
  await assert.rejects(driverPromise(executeFixture(fake, insertQuery, { v: [1, SQL_NULL] })), /^TypeError: Parameter "v" is an array whose elements may not be null, and the element at \[1\] is/u);
};

const checkVectorType = function (vector: EngineType): void {
  assert.equal(columnKind(vector, "mysql"), "float[]");
  assert.equal(renderType(vector), "number[]");
  assert.equal(renderParamType(vector, "mysql"), "number[]");
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("MySQL: a VECTOR is an array of its floats on every driver that reads one, and its parameter binds their text", async () => {
  const vector: EngineType = { kind: "array", nullable_items: false, of: scalarFixture("float4") };
  checkVectorType(vector);
  // The server sends a VECTOR as its floats' bytes, 32-bit and little-endian (MySQL 9.7.2).
  const floats = [1, 2.5, -3, 0.10000000149011612];
  const bytes = Buffer.alloc(16);
  floats.forEach((float, index) => {bytes.writeFloatLE(float, index * 4);});
  await checkVectorDrivers(floats, bytes);
  checkVectorBytes(floats, bytes);
  // A parameter binds the text of its floats, which the engine's `to_vector(?)` reads, on every driver.
  const insertQuery: QueryModule<"mysql"> = { dialect: "mysql", inputs: { v: { type: vector } }, params: ["v"], sql: "insert into items (v) values (to_vector(:v))" };
  await checkVectorBindings(floats, insertQuery);
  await checkInvalidVectors(insertQuery);

});
