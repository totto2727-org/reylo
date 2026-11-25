// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { execute, executeSync } from '#reylo-source/execute.ts';
import type { PgQueryClient, QueryModule } from '#reylo-source/execute.ts';
import { checks } from "#reylo-source/index.ts";
import type { EngineType, JsonSchema } from "#reylo-source/engine-type.ts";
import { forEachFixtureInOrder, nativeDriverDate, promiseDriverStub, SQL_NULL, requireFixtureValue } from "./helpers.ts";
import { asyncDriverMarker, scalarFixture } from "./driver-fixtures.ts";
import { pg, typed, typedValues } from "./execute-test-fixtures.ts";

const scalarInput = (name: string): { type: EngineType } => ({ type: scalarFixture(name) });

const nativeChecks = (database: DatabaseSync, query: QueryModule<"sqlite">, values: Record<string, unknown>): unknown[] =>
  // oxlint-disable-next-line node/no-sync -- These assertions exercise the native SQLite API's synchronous parameter checks.
  executeSync(database, query, values);

const refusal = (name: string): { message: string; name: string } => ({ message: `Parameter "${name}" is a typed JSON, structured or cast parameter, which the run time checks with Reylo's checks; a query defined by hand passes them: defineQuery({ …, checks }) with checks from "@totto2727/reylo".`, name: "TypeError" });

const checkSQLiteCasts = function (): void {
  const db = new DatabaseSync(":memory:");
  try {
    const cast: QueryModule<"sqlite"> = { dialect: "sqlite", inputs: { n: { cast: "integer", type: { kind: "scalar", name: "integer" } } }, params: ["n"], sql: "select cast(:n as integer) as n" };
    assert.throws(() => nativeChecks(db, cast, { n: 1 }), refusal("n"));
    assert.throws(() => nativeChecks(db, { ...cast, checks }, { n: "one" }), /Parameter "n"/u);
    assert.deepEqual(nativeChecks(db, { ...cast, checks }, { n: 1 }), [{ n: 1 }]);
  } finally {
    db.close();
  }
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a typed JSON, structured or cast parameter is checked with the checks its module passes, and refused without them", async () => {
  const client = { query: promiseDriverStub(() => ({ rowCount: 0, rows: [] })) };
  const json: QueryModule<"postgres"> = { dialect: "postgres", inputs: { p: { schema: { properties: { n: { type: "integer" } }, required: ["n"], type: "object" }, type: { kind: "json" } } }, params: ["p"], sql: "select :p::jsonb" };
  await assert.rejects(async () => execute(client, json, { p: { n: 1 } }), refusal("p"));
  // With them, a value the schema or the cast refuses is refused, and one they take is bound.
  await assert.rejects(async () => execute(client, { ...json, checks }, { p: { n: "one" } }), /Parameter "p" at \/n/u);
  assert.deepEqual(await execute(client, { ...json, checks }, { p: { n: 1 } }), []);
  checkSQLiteCasts();
});

const checkMissingSQLiteParameter = function (query: QueryModule<"postgres">): void {
  const database = new DatabaseSync(":memory:");
  try {
    const sqlite: QueryModule<"sqlite"> = { ...query, dialect: "sqlite", sql: "select :x + 1 as y, :email as email" };
    assert.throws(() => nativeChecks(database, sqlite, {}), /Parameter "x" is missing/u);
  } finally {
    database.close();
  }
};

const jsonQuery = (schema: JsonSchema): QueryModule<"postgres"> => ({ checks, dialect: "postgres", inputs: { p: { nullable: false, schema, type: { kind: "json" } } }, params: ["p"], sql: "select :p::jsonb" });
const untypedQuery = (type: EngineType, nullable = false): QueryModule<"postgres"> => ({ checks, dialect: "postgres", inputs: { p: { nullable, type } }, params: ["p"], sql: "select :p::jsonb" });

const checkJsonNulls = async function (client: PgQueryClient, seen: unknown[][]): Promise<void> {
  // A JSON parameter's null there is JSON's null, which pg gets as the JSON text `null`, unless its
  // Schema, the one it is written with or the one its type carries, refuses null; left out, it is
  // Refused, unless its schema has a default.
  await assert.rejects(async () => execute(client, jsonQuery({ type: "integer" }), { p: SQL_NULL }), /Parameter "p" is null/u);
  await assert.rejects(async () => execute(client, jsonQuery({ type: "integer" }), {}), /Parameter "p" is missing/u);
  await assert.rejects(async () => execute(client, jsonQuery({ type: ["integer", "null"] }), {}), /Parameter "p" is missing/u);
  await execute(client, jsonQuery({ type: ["integer", "null"] }), { p: SQL_NULL });
  await execute(client, jsonQuery({ default: 3, type: "integer" }), {});
  assert.deepEqual(seen.slice(2), [["null"], ["3"]]);
};

const checkUntypedJsonNulls = async function (client: PgQueryClient, seen: unknown[][]): Promise<void> {
  await execute(client, untypedQuery({ kind: "json" }), { p: SQL_NULL });
  await assert.rejects(async () => execute(client, untypedQuery({ kind: "json" }), {}), /Parameter "p" is missing/u);
  await execute(client, untypedQuery({ kind: "json", schema: { type: ["integer", "null"] } }), { p: SQL_NULL });
  await assert.rejects(async () => execute(client, untypedQuery({ kind: "json", schema: { type: "integer" } }), { p: SQL_NULL }), /Parameter "p" is null/u);
  // Where the statement takes SQL NULL, a JSON parameter's null is SQL NULL, given or left out.
  await execute(client, untypedQuery({ kind: "json" }, true), { p: SQL_NULL });
  await execute(client, untypedQuery({ kind: "json" }, true), {});
  assert.deepEqual(seen.slice(4), [["null"], ["null"], [SQL_NULL], [SQL_NULL]]);
};

const checkStructuredNull = async function (client: PgQueryClient): Promise<void> {
  // A structured parameter keeps its own message, which says what to pass.
  const rows: QueryModule<"postgres"> = { checks, dialect: "postgres", inputs: { r: { nullable: false, type: { fields: [], kind: "rows", one: true } } }, params: ["r"], sql: "select 1" };
  await assert.rejects(async () => execute(client, rows, { r: SQL_NULL }), /pass one object/u);
};

const checkRequiredParameters = async function (client: PgQueryClient, seen: unknown[][]): Promise<void> {
  const int4 = { kind: "scalar", name: "int4" } as const;
  const fixtureQuery: QueryModule<"postgres"> = { dialect: "postgres", inputs: { email: { nullable: true, type: { kind: "scalar", name: "text" } }, x: { nullable: false, type: int4 } }, params: ["x", "email"], sql: "select :x::int + 1 as y, :email as email" };
  await assert.rejects(async () => execute(client, fixtureQuery, { email: "a", x: SQL_NULL }), { message: `Parameter "x" is null, and the statement takes no null for it: pass a value.`, name: "TypeError" });
  await assert.rejects(async () => execute(client, fixtureQuery, { email: "a" }), { message: `Parameter "x" is missing, and the statement takes no null for it: pass a value.`, name: "TypeError" });
  checkMissingSQLiteParameter(fixtureQuery);
  assert.equal(seen.length, 0);
  // One that takes null binds NULL, given or left out; so does one typed `unknown`, and one a
  // Query defined by hand leaves without `nullable`.
  await execute(client, fixtureQuery, { x: 1 });
  await execute(client, { ...fixtureQuery, inputs: { email: { type: int4 }, x: { nullable: false, type: { kind: "unknown" } } } }, { email: SQL_NULL, x: SQL_NULL });
  assert.deepEqual(seen, [[1, SQL_NULL], [SQL_NULL, SQL_NULL]]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a parameter the statement takes no null for refuses null and refuses to be left out, before the statement runs, and a JSON one takes JSON's null", async () => {
  const seen: unknown[][] = [];
  const client = { query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values));
    return { rowCount: 0, rows: [] };
  }) };
  await checkRequiredParameters(client, seen);
  await checkJsonNulls(client, seen);
  await checkUntypedJsonNulls(client, seen);
  await checkStructuredNull(client);
});

const checkHandWrittenArray = async function (unsafe: (text: string, values?: unknown[]) => Promise<never[]>, seen: unknown[][]): Promise<void> {
  // Hand-written inputs work through the runtime's own lexer too, a repeated name included.
  const hand: QueryModule<"postgres"> = { dialect: "postgres", inputs: { ids: { type: { kind: "array", of: { kind: "scalar", name: "int4" } } } }, params: ["ids"], sql: "select :ids::int[] = :ids::int[]" };
  seen.length = 0;
  await execute({ unsafe }, hand, { ids: [2] });
  assert.deepEqual(seen, [['{"2"}']]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a query without inputs, defined by hand or built before them, binds every array as it is", async () => {
  const { inputs: _inputs, ...bare } = typed;
  const seen: unknown[][] = [];
  const unsafe = promiseDriverStub((_sql: string, values?: unknown[]): never[] => {
    seen.push(requireFixtureValue(values));
    return [];
  });
  const bun = { commitDistributed: asyncDriverMarker, unsafe };
  await execute(bun, bare, typedValues);
  await execute({ unsafe }, bare, typedValues);
  await execute({ query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values));
    return { rows: [] };
  }) }, bare, typedValues);
  Iterator.from(seen).forEach((values) => {assert.deepEqual(values, [[1, 3], "ada", [1, { a: "b" }]]);});
  await checkHandWrittenArray(unsafe, seen);
});

const DATE_QUERY: QueryModule<"postgres"> = {
  dialect: "postgres",
  inputs: {
    at: scalarInput("timestamp"),
    day: scalarInput("date"),
    days: { type: { kind: "array", of: scalarFixture("date") } },
    tz: scalarInput("timestamptz"),
    tzs: { type: { kind: "array", of: scalarFixture("timestamptz") } },
  },
  params: ["at", "day", "tz", "tzs", "days"],
  sql: "select :at::timestamp, :day::date, :tz::timestamptz, :tzs::timestamptz[], :days::date[]",
};

const DATE_VALUES = { at: "2026-10-12 19:06:48.282", day: "2026-10-12", days: [["2026-10-12"]], tz: "1970-01-01T00:00:00Z", tzs: ["2026-10-12T19:06:48.282Z", "2026-10-12 19:06:48+09", "2026-10-12 19:06:48.5-07:30", "2026-10-12 19:06 America/Los_Angeles", "2026-10-12 19:06:48 UTC", "infinity", "-infinity", "0001-01-01 00:00:00+00 BC", "+010000-01-01T00:00:00Z"] };

const checkInvalidPgDateInputs = async function (client: PgQueryClient): Promise<void> {
  const refused = async (values: Record<string, unknown>, message: RegExp): Promise<void> => {
    await assert.rejects(async () => {
      await execute(client, DATE_QUERY, { ...DATE_VALUES, ...values });
    }, (candidate: unknown) => candidate instanceof TypeError && message.test(candidate.message));
  };
  await refused({ at: nativeDriverDate() }, /^Parameter "at" is a timestamp without a time zone, so it takes the wall-clock text/u);
  await refused({ day: nativeDriverDate() }, /^Parameter "day" is a date without a time zone/u);
  await refused({ days: [[nativeDriverDate()]] }, /^Parameter "days" is a date/u);
  // A timestamptz takes the string `.run()` returns for one, and a Date nowhere.
  await refused({ tz: nativeDriverDate(0) }, /^Parameter "tz" is a timestamptz, which takes the instant as a string that names its zone, as `\.run\(\)` returns one, not a Date: pass date\.toISOString\(\)/u);
  await refused({ tzs: ["2026-10-12T00:00:00Z", nativeDriverDate(0)] }, /^Parameter "tzs" is a timestamptz, .*not a Date/u);
  await forEachFixtureInOrder(["2026-10-12 19:06:48", "2026-10-12T19:06:48.282", "2026-10-12"], async (tz) => {
    await refused({ tz }, /^Parameter "tz" is a timestamptz, an instant, so a string for it names its zone/u);
  });
  await refused({ tzs: ["2026-10-12T00:00:00Z", "2026-10-12 19:06"] }, /^Parameter "tzs" is a timestamptz/u);
  // An array parameter takes no null element, as its type says, in any dimension.
  await refused({ tzs: ["2026-10-12T00:00:00Z", SQL_NULL] }, /^Parameter "tzs" is an array whose elements may not be null, and the element at \[1\] is/u);
  await refused({ days: [["2026-10-12", undefined]] }, /^Parameter "days" is an array whose elements may not be null, and the element at \[0\]\[1\] is/u);
};

const checkInvalidMysqlDate = async function (): Promise<void> {
  // MySQL's DATETIME and TIMESTAMP are the engine's timestamp, and a placeholder compared with both is either.
  const mysql: QueryModule<"mysql"> = { dialect: "mysql", inputs: { at: scalarInput("date|timestamp") }, params: ["at"], sql: "select :at" };
  const client = { execute: promiseDriverStub(() => [[], []] as [unknown, unknown]), query: promiseDriverStub(() => [[], []] as [unknown, unknown]) };
  await assert.rejects(async () => {
    await execute(client, mysql, { at: nativeDriverDate() });
  }, /^TypeError: Parameter "at" is a timestamp without a time zone/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a Date for any date or time parameter, and a string without its zone for a timestamptz one, is refused before the statement runs", async () => {
  const seen: unknown[][] = [];
  const client = { query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values));
    return { rows: [] };
  }) };
  await execute(client, DATE_QUERY, DATE_VALUES);
  assert.equal(seen.length, 1);
  await checkInvalidPgDateInputs(client);
  assert.equal(seen.length, 1);
  await checkInvalidMysqlDate();
});

const checkMysqlBoolean = async function (seen: unknown[][]): Promise<void> {
  // MySQL's drivers bind a boolean as 1 themselves.
  const mq: QueryModule<"mysql"> = { dialect: "mysql", inputs: { f: scalarInput("int4") }, params: ["f"], sql: "select :f as f" };
  seen.length = 0;
  await execute({ execute: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(requireFixtureValue(boundValues));
    return [[], []] as [unknown, unknown];
  }), query: promiseDriverStub(() => [[], []] as [unknown, unknown]) }, mq, { f: true });
  assert.deepEqual([...seen], [[true]]);
};

const checkPostgresYears = async function (seen: unknown[][]): Promise<void> {
  // Postgres refuses `+010000` and the year 0000, which run returns for years past 9999 and 1 BC.
  const pq: QueryModule<"postgres"> = {
    dialect: "postgres",
    inputs: { bc: scalarInput("timestamptz"), days: { type: { kind: "array", of: { kind: "scalar", name: "date" } } }, far: scalarInput("timestamptz"), huge: scalarInput("date"), now: scalarInput("timestamptz"), old: scalarInput("timestamp"), zero: scalarInput("date") },
    params: ["far", "bc", "zero", "now", "days", "old", "huge"],
    sql: "select :far::timestamptz, :bc::timestamptz, :zero::date, :now::timestamptz, :days::date[], :old::timestamp, :huge::date",
  };
  const values = { bc: "-000001-06-01T12:00:00.5Z", days: ["+010000-01-01", "2026-10-20"], far: "+010000-01-01T00:00:00Z", huge: "+5874897-12-31", now: "2026-10-20T10:00:00Z", old: "-000001-06-01T12:00:00", zero: "0000-01-01" };
  seen.length = 0;
  await execute({ query: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(requireFixtureValue(boundValues));
    return { rows: [] };
  }) }, pq, values);
  assert.deepEqual([...seen], [["10000-01-01T00:00:00Z", "0002-06-01T12:00:00.5Z BC", "0001-01-01 BC", "2026-10-20T10:00:00Z", '{"10000-01-01","2026-10-20"}', "0002-06-01T12:00:00 BC", "5874897-12-31"]]);
};

const checkPostgresIntervals = async function (seen: unknown[][]): Promise<void> {
  // Postgres refuses a sign before an ISO 8601 duration's `P`, which run returns for a negative interval.
  const iq: QueryModule<"postgres"> = {
    dialect: "postgres",
    inputs: { ahead: scalarInput("interval"), back: scalarInput("interval"), mixed: scalarInput("interval"), spans: { type: { kind: "array", of: { kind: "scalar", name: "interval" } } }, text: scalarInput("interval") },
    params: ["back", "ahead", "mixed", "text", "spans"],
    sql: "select :back::interval, :ahead::interval, :mixed::interval, :text::interval, :spans::interval[]",
  };
  seen.length = 0;
  await execute({ query: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(requireFixtureValue(boundValues));
    return { rows: [] };
  }) }, iq, { ahead: "P1M", back: "-P1DT2H0.5S", mixed: "P1M-1D", spans: ["-PT3S", "P1D"], text: "-1 days" });
  assert.deepEqual([...seen], [["P-1DT-2H-0.5S", "P1M", "P1M-1D", "-1 days", '{"PT-3S","P1D"}']]);
};

const checkLegacyBoolean = async function (query: QueryModule<"sqlite">, seen: unknown[][]): Promise<void> {
  // Without inputs, as defined by hand, every value goes as it is.
  const { inputs: _inputs, ...bare } = query;
  seen.length = 0;
  await execute({ execute: promiseDriverStub((st: { args: unknown[] }) => {
    seen.push(st.args);
    return { rows: [] };
  }), executeMultiple: asyncDriverMarker }, bare, { a: true, b: false, n: 7 });
  assert.deepEqual([...seen], [[true, false, 7]]);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("what run returns goes back in: a SQLite truth value as 1 or 0, a Postgres extended or BC year in Postgres's own form", async () => {
  // SQLite: better-sqlite3 refuses a boolean and libSQL binds it as the REAL 1.0.
  const lq: QueryModule<"sqlite"> = { dialect: "sqlite", inputs: { a: scalarInput("numeric"), b: scalarInput("integer"), n: scalarInput("integer") }, params: ["a", "b", "n"], sql: "select :a as a, :b as b, :n as n" };
  const seen: unknown[][] = [];
  await execute({ execute: promiseDriverStub((st: { args: unknown[] }) => {
    seen.push(st.args);
    return { rows: [] };
  }), executeMultiple: asyncDriverMarker }, lq, { a: true, b: false, n: 7 });
  assert.deepEqual([...seen], [[1, 0, 7]]);
  await checkMysqlBoolean(seen);
  await checkPostgresYears(seen);
  await checkPostgresIntervals(seen);
  await checkLegacyBoolean(lq, seen);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a parameter left out binds NULL, which postgres.js, mysql2, node:sqlite and libSQL would reject", async () => {
  const seen: unknown[][] = [];
  const client = { unsafe: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values));
    return [];
  }) };
  await execute(client, pg, { id: 1 });
  await execute(client, { ...pg, order: ["name", "id"], text: "select $1, $2" }, { id: undefined });
  assert.deepEqual(seen, [[1, SQL_NULL], [SQL_NULL, SQL_NULL]]);
});
