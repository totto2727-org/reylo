// oxlint-disable-next-line rules/no-node-imports -- Use the native SQLite driver and the exact types it binds.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { QueryModule } from "#reylo-source/execute.ts";
import { isEmptyArray, matchesBigInt } from "#reylo-source/native-predicates.ts";
import { requireFixtureValue } from "./helpers.ts";

export interface Call { method: string; args: unknown[] }
export const pg: QueryModule<"postgres"> = { dialect: "postgres", params: ["id", "name"], sql: "select :id::int as id, :name as name, :id as again" };
export const my: QueryModule<"mysql"> = { dialect: "mysql", params: ["id", "name"], sql: "select :id as id, :name as name, :id as again" };
export const lite: QueryModule<"sqlite"> = { dialect: "sqlite", params: ["id", "name"], sql: "select :id as id, :name as name, :id as again" };
export const row = { again: 1, id: 1, name: "ada" };

// The module's `inputs`: :ids is an int4[] parameter, :data a jsonb one, :name text.
export const typed: QueryModule<"postgres"> = {
  dialect: "postgres",
  inputs: { data: { type: { kind: "json" } }, ids: { type: { kind: "array", of: { kind: "scalar", name: "int4" } } }, name: { type: { kind: "scalar", name: "text" } } },
  order: ["ids", "name", "data"],
  params: ["ids", "name", "data"],
  sql: "select id from users where id = any(:ids) and name = :name and tags @> :data::jsonb",
  text: "select id from users where id = any($1) and name = $2 and tags @> $3::jsonb",
};
// oxlint-disable-next-line eslint/no-magic-numbers -- These values are the exact JSON and array parameters a driver must receive.
export const typedValues = { data: [1, { a: "b" }], ids: [1, 3], name: "ada" };

const BINARY_RANGE_START = 1;
const BINARY_RANGE_END = 4;
// oxlint-disable-next-line eslint/no-magic-numbers -- These three bytes are the driver fixture payload.
const FIXTURE_BYTES = [1, 2, 255];
const PADDING_BYTE = 9;
const PADDED_FIXTURE_BYTES = [PADDING_BYTE, ...FIXTURE_BYTES, PADDING_BYTE];

export const binary = (): { plain: Uint8Array; view: Uint8Array } => ({
  plain: Uint8Array.from(FIXTURE_BYTES),
  view: Uint8Array.from(PADDED_FIXTURE_BYTES).subarray(BINARY_RANGE_START, BINARY_RANGE_END),
});
export const bin: QueryModule<"mysql"> = { dialect: "mysql", params: ["plain", "view", "buf", "n"], sql: "select hex(:plain), hex(:view), hex(:buf), :n" };

// A SQLite-backed Durable Object's ctx.storage.sql, as workerd's answers
// (lab/driver-matrix/probes/durable-object.mjs): exec() runs at once and returns a cursor; a BigInt
// Binding throws; an INTEGER comes back as a number, rounded past 2^53; a BLOB as an ArrayBuffer.
interface DurableFixture {
  databaseSize: number;
  exec: (sql: string, ...bindings: SQLInputValue[]) => { toArray: () => unknown[]; columnNames: string[] };
}

const FIXTURE_DATABASE_SIZE = 4096;

const durableValue = (value: unknown): unknown => {
  if (matchesBigInt(value)) {return Number(value);}
  return value instanceof Uint8Array ? Uint8Array.from(value).buffer : value;
};

export const durableObjectSql = function durableObjectSql(db: DatabaseSync): DurableFixture {
  return {
    get databaseSize() {return FIXTURE_DATABASE_SIZE;},
    exec: (sql: string, ...bindings: SQLInputValue[]) => {
      if (bindings.some((binding) => matchesBigInt(binding))) {
        // oxlint-disable-next-line rules/require-tagged-error -- Workerd rejects a native SQL BigInt binding with this TypeError.
        throw new TypeError("Cannot convert a BigInt value to a number");
      }
      const st = db.prepare(sql);
      st.setReadBigInts(true);
      const rows = st.all(...bindings).map((nativeRow) =>
        Object.fromEntries(Object.entries(nativeRow).map(([key, value]) => [key, durableValue(value)])),
      );
      return { columnNames: isEmptyArray(rows) ? [] : Object.keys(requireFixtureValue(rows[0])), toArray: () => rows };
    },
  };
};
