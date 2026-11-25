// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { arrayLiteral, execute } from '#reylo-source/execute.ts';
import type { QueryModule } from '#reylo-source/execute.ts';
import { hasObjectType, isRecord, matchesNull } from "#reylo-source/native-predicates.ts";
import { forEachFixtureInOrder, nativeDriverDate, plain, promiseDriverStub, SQL_NULL, requireFixtureValue } from "./helpers.ts";
import { asyncDriverMarker, driverPromise, driverRow, driverRows, executeFixture, scalarFixture } from "./driver-fixtures.ts";
import { typed, typedValues } from "./execute-test-fixtures.ts";

const JSON_INPUTS = Object.fromEntries(["s", "n", "b", "t", "z", "o", "e"].map((key): [string, { type: { kind: "json" } }] => [key, { type: { kind: "json" } }]));

// Every kind of JSON value, null, and a jsonb[] parameter, whose elements are JSON values.
const jsonQuery: QueryModule<"postgres"> = {
  dialect: "postgres",
  inputs: { ...JSON_INPUTS, l: { type: { kind: "array", of: { kind: "json" } } } },
  params: ["s", "n", "b", "t", "z", "o", "e", "l"],
  sql: "select :s::jsonb, :n::jsonb, :b::jsonb, :t::jsonb, :z::jsonb, :o::jsonb, :e::jsonb, :l::jsonb[]",
};
const jsonValues = { b: true, e: [], l: ["x", { a: 1 }, [true]], n: 5, o: { d: nativeDriverDate("2026-01-02T03:04:05Z") }, s: "abc", t: '{"a":1}', z: SQL_NULL };
const jsonTexts = ['"abc"', "5", "true", String.raw`"{\"a\":1}"`, SQL_NULL, '{"d":"2026-01-02T03:04:05.000Z"}', "[]", String.raw`{"\"x\"","{\"a\":1}","[true]"}`];

const nativeTyped = (value: unknown, type: number): { type: number; value: unknown } => ({ type, value });

const scalarInput = (name: string): { type: ReturnType<typeof scalarFixture> } => ({ type: scalarFixture(name) });

const collectPostgresValues = async function (query: QueryModule<"postgres">, inputs: Record<string, unknown>, seen: unknown[][]): Promise<void> {
  await execute({ query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values));
    return { rows: [] };
  }) }, query, inputs);
  const pgPromise = { manyOrNone: promiseDriverStub(() => []), query: promiseDriverStub((config: { values: unknown[] }) => {
    seen.push(config.values);
    return [];
  }) };
  await executeFixture(pgPromise, query, inputs);
  await execute(promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values));
    return [];
  }), query, inputs);
};

const unwrap = (candidate: unknown): unknown => {
  if (!isRecord(candidate)) {return candidate;}
  assert.equal(candidate.type, 705);
  return candidate.value;
};

interface PgCapture {
  getTypeParser: () => StringConstructor;
  query: (config: { values: unknown[] }) => Promise<{ fields: unknown[]; rows: unknown[] }>;
}

const pgCapture = (seen: unknown[][]): PgCapture => ({
  getTypeParser: () => String,
  query: promiseDriverStub((config: { values: unknown[] }) => {
    seen.push(config.values);
    return { fields: [], rows: [] };
  }),
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: every client gets an array for a SQL array parameter as its literal text; Bun.sql gets a JSON parameter as an object it serializes to its JSON text, postgres.js as its JSON text declared unknown", async () => {
  const seen: unknown[][] = [];
  const unsafe = promiseDriverStub((_sql: string, values?: unknown[]): never[] => {
    seen.push(requireFixtureValue(values));
    return [];
  });
  const bun = { commitDistributed: asyncDriverMarker, unsafe };
  await execute(bun, typed, typedValues);
  await execute({ unsafe }, typed, typedValues);
  assert.equal(seen.length, 2);
  Iterator.from(seen).forEach(([ids, name, data]) => {
    assert.deepEqual([ids, name], ['{"1","3"}', "ada"]);
    // Not a string, which they would store as a JSON string, and not the array, whose type they would take from its first element.
    assert.equal(typeof data, "object");
    assert.ok(!Array.isArray(data));
    assert.equal(JSON.stringify(data), '[1,{"a":"b"}]');
  });
  // Postgres.js (typed() beside unsafe()), whose JSON serializer Drizzle replaces with one that passes the value through.
  const postgresJs = { typed: nativeTyped, unsafe };
  await execute(postgresJs, typed, typedValues);
  assert.deepEqual(seen.at(-1), ['{"1","3"}', "ada", { type: 705, value: '[1,{"a":"b"}]' }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: a JSON parameter's value is a JavaScript value, which every driver gets as its JSON text, a string as a JSON string, null as NULL", async () => {
  const seen: unknown[][] = [];
  await collectPostgresValues(jsonQuery, jsonValues, seen);
  const unsafe = promiseDriverStub((_sql: string, values?: unknown[]): never[] => {
    seen.push(requireFixtureValue(values).map((currentValue) => (!matchesNull(currentValue) && hasObjectType(currentValue) ? JSON.stringify(currentValue) : currentValue)));
    return [];
  });
  const bun = { commitDistributed: asyncDriverMarker, unsafe };
  await execute({ unsafe }, jsonQuery, jsonValues);
  await execute(bun, jsonQuery, jsonValues);
  // Postgres.js gets each JSON value as its text declared unknown (705), and null as null.
  const postgresJs = { typed: nativeTyped, unsafe: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(requireFixtureValue(values).map((value) => unwrap(value)));
    return [];
  }) };
  await execute(postgresJs, jsonQuery, jsonValues);
  assert.equal(seen.length, 6);
  Iterator.from(seen).forEach((values) => {assert.deepEqual(values, jsonTexts);});
});

const checkNativeJson = function (query: QueryModule<"sqlite">, values: Record<string, unknown>): void {
  const database = new DatabaseSync(":memory:");
  try {
    const rows = driverRows(execute(database, query, values));
    assert.deepEqual(plain(rows.map((row) => driverRow(row))), [{ a: "[1,2]", again: "[1,2]", b: '"abc"', name: "ada", z: SQL_NULL }]);
  } finally {
    database.close();
  }
};

const collectMysqlJson = async function (query: QueryModule<"mysql">, values: Record<string, unknown>, seen: unknown[][]): Promise<void> {
  await execute({ execute: promiseDriverStub((_statement: unknown, boundValues?: unknown[]) => {
    seen.push(requireFixtureValue(boundValues));
    return [[], []] as [unknown, unknown];
  }), query: promiseDriverStub(() => [[], []] as [unknown, unknown]) }, query, values);
  await execute({ batch: promiseDriverStub(() => []), query: promiseDriverStub((_sql: string, boundValues: unknown) => {
    seen.push(driverRows(boundValues));
    return [];
  }) }, query, values);
  await execute({ commitDistributed: asyncDriverMarker, unsafe: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(requireFixtureValue(boundValues));
    return [];
  }) }, query, values);
};

const JSON_PARAMETER = { type: { kind: "json" } } as const;
const MYSQL_JSON: QueryModule<"mysql"> = { dialect: "mysql", inputs: { a: JSON_PARAMETER, b: JSON_PARAMETER, name: { type: { kind: "scalar", name: "text" } }, z: JSON_PARAMETER }, params: ["a", "b", "name", "z"], sql: "select cast(:a as json), cast(:b as json), :name, cast(:a as json), cast(:z as json)" };
const JSON_VALUES = { a: [1, 2], b: "abc", name: "ada", z: SQL_NULL };
const JSON_EXPECTED = ["[1,2]", '"abc"', "ada", "[1,2]", SQL_NULL];

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql and sqlite: every driver gets a JSON parameter as its JSON text, and null as NULL", async () => {
  const seen: unknown[][] = [];
  await collectMysqlJson(MYSQL_JSON, JSON_VALUES, seen);
  const lq: QueryModule<"sqlite"> = { ...MYSQL_JSON, dialect: "sqlite", sql: "select json(:a) as a, json(:b) as b, :name as name, json(:a) as again, json(:z) as z" };
  await execute({ execute: promiseDriverStub((statement: { args: unknown[] }) => {
    seen.push(statement.args);
    return { rows: [] };
  }), executeMultiple: asyncDriverMarker }, lq, JSON_VALUES);
  assert.equal(seen.length, 4);
  // Node:sqlite would read an array as its named parameters.
  checkNativeJson(lq, JSON_VALUES);
  Iterator.from(seen).forEach((bound) => {assert.deepEqual(bound, JSON_EXPECTED);});
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: pg's family, PGlite and Neon, which write any array as an array literal, get an array for a JSON parameter as its JSON text", async () => {
  const seen: unknown[][] = [];
  await collectPostgresValues(typed, typedValues, seen);
  assert.equal(seen.length, 3);
  Iterator.from(seen).forEach((values) => {assert.deepEqual(values, ['{"1","3"}', "ada", '[1,{"a":"b"}]']);});
});

const DATE_QUERY: QueryModule<"postgres"> = { dialect: "postgres", inputs: { at: scalarInput("timestamp"), d: scalarInput("timestamptz"), day: scalarInput("date"), name: scalarInput("text"), tz: scalarInput("timestamptz") }, params: ["at", "day", "tz", "d", "name"], sql: "select :at::timestamp, :day::date, :tz::timestamptz, :d::timestamptz, :name::text" };
const DATE_VALUES = { at: "2026-01-02 03:04:05.006", d: "1970-01-01T00:00:00Z", day: "infinity", name: "ada", tz: "2026-01-02 03:04:05 America/New_York" };

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: postgres.js, which binds a date or time string through new Date(), gets one declared unknown; Bun.sql gets the string", async () => {
  const seen: unknown[][] = [];
  const unsafe = promiseDriverStub((_sql: string, boundValues?: unknown[]): never[] => {
    seen.push(requireFixtureValue(boundValues));
    return [];
  });
  const postgresJs = { typed: nativeTyped, unsafe };
  await execute(postgresJs, DATE_QUERY, DATE_VALUES);
  const bun = { commitDistributed: asyncDriverMarker, typed: nativeTyped, unsafe };
  await execute(bun, DATE_QUERY, DATE_VALUES);
  assert.deepEqual(seen, [
    [{ type: 705, value: "2026-01-02 03:04:05.006" }, { type: 705, value: "infinity" }, { type: 705, value: "2026-01-02 03:04:05 America/New_York" }, { type: 705, value: "1970-01-01T00:00:00Z" }, "ada"],
    ["2026-01-02 03:04:05.006", "infinity", "2026-01-02 03:04:05 America/New_York", "1970-01-01T00:00:00Z", "ada"],
  ]);
});

const checkArrayDate = function (): void {
  // Pg's dateToString: the local time, then the offset.
  const date = nativeDriverDate("2026-01-02T03:04:05.006");
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  assert.equal(arrayLiteral([date]), `{"2026-01-02T03:04:05.006${zone}"}`);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("arrayLiteral writes a Postgres array literal as pg does: nesting, NULL, quotes, backslashes, binary, dates, the empty array", () => {
  assert.equal(arrayLiteral([]), "{}");
  assert.equal(arrayLiteral([1, BigInt("2"), 1.5, true]), '{"1","2","1.5","true"}');
  assert.equal(arrayLiteral([[1, 2], [3, SQL_NULL], []]), '{{"1","2"},{"3",NULL},{}}');
  assert.equal(arrayLiteral([SQL_NULL, undefined, "", "NULL"]), '{NULL,NULL,"","NULL"}');
  assert.equal(arrayLiteral(['say "hi"', String.raw`back\slash`, "a,b", "{x}", " pad "]), String.raw`{"say \"hi\"","back\\slash","a,b","{x}"," pad "}`);
  assert.equal(arrayLiteral([Uint8Array.of(1, 2, 255), Buffer.from([0, 16]), new Uint8Array([9, 171, 9]).subarray(1, 2)]), String.raw`{\\x0102ff,\\x0010,\\xab}`);
  assert.equal(arrayLiteral([{ a: 'q"' }]), String.raw`{"{\"a\":\"q\\\"\"}"}`);
  checkArrayDate();
  // An element type's own delimiter, between sub-arrays too: PostGIS's geometry is `:`.
  assert.equal(arrayLiteral(["0101", SQL_NULL, "0102"], ":"), '{"0101":NULL:"0102"}');
  assert.equal(arrayLiteral([["a"], ["b"]], ";"), '{{"a"};{"b"}}');
});

const checkVectorRefusals = async function (client: PgCapture, nearest: QueryModule<"postgres">): Promise<void> {
  // JSON would write NaN and ±Infinity as null, and pgvector refuses them and an empty vector.
  const invalid = [[[1, Number.NaN], /pgvector vector, an array of finite numbers, and the element at \[1\] is NaN/u], [[Infinity], /element at \[0\] is Infinity/u], [["1"], /element at \[0\] is "1"/u], [[], /one dimension at least; got an empty array/u]] as const;
  await forEachFixtureInOrder(invalid, async ([vectorInput, why]) => {
    await assert.rejects(driverPromise(executeFixture(client, nearest, { h: SQL_NULL, q: vectorInput, qs: [] })), why);
  });
  await assert.rejects(driverPromise(executeFixture(client, nearest, { h: SQL_NULL, q: [1], qs: [[1], [Number.NaN]] })), /element at \[0\] is NaN/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: a pgvector vector parameter takes an array of finite numbers, written as the text pgvector reads; an array of them as an array of those texts", async () => {
  const seen: unknown[][] = [];
  const client = pgCapture(seen);
  const vector = { kind: "scalar", name: "vector" } as const;
  const nearest: QueryModule<"postgres"> = {
    dialect: "postgres",
    inputs: { h: { type: { kind: "scalar", name: "halfvec" } }, q: { type: vector }, qs: { type: { kind: "array", of: vector } } },
    params: ["q", "qs", "h"],
    sql: "select id from items where embedding <-> :q < 1 or embedding = any(:qs) or half = :h",
  };
  await executeFixture(client, nearest, { h: [0.5], q: [1, 2.5, -3, 1e-7], qs: [[1, 2], [3]] });
  assert.deepEqual(seen, [["[1,2.5,-3,1e-7]", '{"[1,2]","[3]"}', "[0.5]"]]);
  // The text pgvector itself prints passes as it is.
  await executeFixture(client, nearest, { h: SQL_NULL, q: "[1,2]", qs: [] });
  assert.deepEqual(seen.at(-1), ["[1,2]", "{}", SQL_NULL]);
  await checkVectorRefusals(client, nearest);
});

const checkHstoreRefusals = async function (client: PgCapture, save: QueryModule<"postgres">): Promise<void> {
  await assert.rejects(driverPromise(executeFixture(client, save, { history: [], prefs: { n: 1 } })), /Parameter "prefs" is an hstore, whose values are strings or null, and its key "n" holds 1/u);
  await assert.rejects(driverPromise(executeFixture(client, save, { history: [], prefs: ["a"] })), /Parameter "prefs" is an hstore, an object of its keys/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: an hstore parameter takes an object of its keys, written as the text hstore reads; an array of them as an array of those texts", async () => {
  const seen: unknown[][] = [];
  const client = pgCapture(seen);
  const hstore = { kind: "scalar", name: "hstore" } as const;
  const save: QueryModule<"postgres"> = {
    dialect: "postgres",
    inputs: { history: { type: { kind: "array", of: hstore } }, prefs: { type: hstore } },
    params: ["prefs", "history"],
    sql: "update settings set prefs = :prefs where history = any(:history)",
  };
  // This input order is part of the hstore text that the fixture checks.
  const prefs = Object.fromEntries([["theme", "dark"], ['q"', "\\"], ["gone", SQL_NULL]]);
  await executeFixture(client, save, { history: [{ a: "1" }, {}], prefs });
  assert.deepEqual(seen, [[String.raw`"theme"=>"dark", "q\""=>"\\", "gone"=>NULL`, String.raw`{"\"a\"=>\"1\"",""}`]]);
  // Its text passes as it is.
  await executeFixture(client, save, { history: [], prefs: '"a"=>"1"' });
  assert.deepEqual(seen.at(-1), ['"a"=>"1"', "{}"]);
  await checkHstoreRefusals(client, save);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: an array parameter is written with its element type's delimiter, which the module's inputs carry", async () => {
  const seen: unknown[][] = [];
  const client = pgCapture(seen);
  const shapes: QueryModule<"postgres"> = {
    dialect: "postgres",
    inputs: { shapes: { type: { delimiter: ":", kind: "array", of: { kind: "scalar", name: "geometry" } } } },
    params: ["shapes"],
    sql: "select id from places where shape = any(:shapes)",
  };
  await executeFixture(client, shapes, { shapes: ["0101", "0102"] });
  assert.deepEqual(seen, [['{"0101":"0102"}']]);
});
