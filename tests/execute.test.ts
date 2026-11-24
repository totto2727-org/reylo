// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import { join } from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
import { arrayLiteral, execute, executeSync } from '#reylo-source/execute.ts';
import type { QueryModule } from '#reylo-source/execute.ts';
import { checks, defineQuery } from "#reylo-source/index.ts";
import type { EngineType, JsonSchema } from "#reylo-source/engine-type.ts";
// oxlint-disable-next-line import/no-relative-parent-imports -- Match the native driver boundary in this direct Node integration test.
import { matchesNullish } from "#reylo-source/native-predicates.ts";
import { nativeDriverDate, promiseDriverStub, NO_DRIVER_ERROR, NO_ROW, SQL_NULL } from "./helpers.ts";

// Each fake client records what execute handed it and answers the way its driver does; the
// Driver behaviour each one copies was checked against the real package (lab/driver-matrix).
interface Call { method: string; args: unknown[] }
const pg: QueryModule<"postgres"> = { dialect: "postgres", sql: "select :id::int as id, :name as name, :id as again", params: ["id", "name"] };
const my: QueryModule<"mysql"> = { dialect: "mysql", sql: "select :id as id, :name as name, :id as again", params: ["id", "name"] };
const lite: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select :id as id, :name as name, :id as again", params: ["id", "name"] };
const row = { id: 1, name: "ada", again: 1 };

const queryPromise = (result: unknown): Promise<unknown> => {
  assert.ok(result instanceof Promise, "Expected the native asynchronous query path to return a Promise");
  return result;
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: query(text, values) → { rows }, as on pg, PGlite and Neon's Pool, with $n numbered once per name", async () => {
  const calls: Call[] = [];
  const client = { query: promiseDriverStub((...args: unknown[]) => {
    calls.push({ method: "query", args });
    return { rows: [row], rowCount: 1 };
  }) };
  assert.deepEqual(await execute(client, pg, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(calls, [{ args: ["select $1::int as id, $2 as name, $1 as again", [1, "ada"]], method: "query" }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: a query() that resolves to the rows, as Neon's neon() from 1.0 and pg-promise do", async () => {
  const neon = Object.assign(() => Promise.reject(new Error("not a template")), {
    query: promiseDriverStub(() => [row]),
    // Neon's unsafe() builds a fragment for a template; it must never be taken for a query.
    unsafe: () => ({ sql: "fragment" }),
  });
  assert.deepEqual(await execute(neon as never, pg, { id: 1, name: "ada" }), [row]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: pg-promise gets a { text, values } object, so it binds instead of formatting $1 into the text", async () => {
  const calls: Call[] = [];
  // Pg-promise types query() as resolving to any.
  const db = { manyOrNone: promiseDriverStub(() => []), query: async (...args: unknown[]): Promise<any> => {
    calls.push({ method: "query", args });
    return [row];
  } };
  const fixtureQuery: QueryModule<"postgres"> = { dialect: "postgres", sql: "select '$2' as literal, :id::int as id", params: ["id"] };
  assert.deepEqual(await execute(db, fixtureQuery, { id: 1 }), [row]);
  // With Reylo's decoder table, which answers every oid itself.
  const { types, ...bound } = calls[0]!.args[0] as { text: string; values: unknown[]; types: { getTypeParser(oid: number): (text: string) => unknown } };
  assert.deepEqual(bound, { text: "select '$2' as literal, $1::int as id", values: [1] });
  assert.equal(types.getTypeParser(20)("9007199254740993"), BigInt("9007199254740993"));
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: unsafe(text, values) → rows, as on postgres.js and Bun.sql and their transactions; postgres.js is asked to prepare the statement", async () => {
  const calls: Call[] = [];
  const tx = { unsafe: (...args: unknown[]) => {
    calls.push({ method: "unsafe", args });
    return Promise.resolve([row]);
  } };
  assert.deepEqual(await execute(tx, pg, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(calls, [{ args: ["select $1::int as id, $2 as name, $1 as again", [1, "ada"], { prepare: true }], method: "unsafe" }]);
  // Bun.sql prepares a statement itself, and takes no options.
  const bunCalls: Call[] = [];
  const bun = { unsafe: (...args: unknown[]) => {
    bunCalls.push({ method: "unsafe", args });
    return Promise.resolve([row]);
  }, commitDistributed: async () => {} };
  assert.deepEqual(await execute(bun, pg, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(bunCalls, [{ args: ["select $1::int as id, $2 as name, $1 as again", [1, "ada"]], method: "unsafe" }]);
});

// The module's `inputs`: :ids is an int4[] parameter, :data a jsonb one, :name text.
const typed: QueryModule<"postgres"> = {
  dialect: "postgres",
  sql: "select id from users where id = any(:ids) and name = :name and tags @> :data::jsonb",
  params: ["ids", "name", "data"],
  text: "select id from users where id = any($1) and name = $2 and tags @> $3::jsonb",
  order: ["ids", "name", "data"],
  inputs: { ids: { type: { kind: "array", of: { kind: "scalar", name: "int4" } } }, name: { type: { kind: "scalar", name: "text" } }, data: { type: { kind: "json" } } },
};
const typedValues = { ids: [1, 3], name: "ada", data: [1, { a: "b" }] };

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: every client gets an array for a SQL array parameter as its literal text; Bun.sql gets a JSON parameter as an object it serializes to its JSON text, postgres.js as its JSON text declared unknown", async () => {
  const seen: unknown[][] = [];
  const unsafe = async (_sql: string, values?: unknown[]): Promise<never[]> => {
    seen.push(values!);
    return [];
  };
  const bun = { unsafe, commitDistributed: async () => {} };
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
  const postgresJs = { unsafe, typed: (value: unknown, type: number) => ({ value, type }) };
  await execute(postgresJs, typed, typedValues);
  assert.deepEqual(seen.at(-1), ['{"1","3"}', "ada", { type: 705, value: '[1,{"a":"b"}]' }]);
});

// Every kind of JSON value, null, and a jsonb[] parameter, whose elements are JSON values.
const jsonQuery: QueryModule<"postgres"> = {
  dialect: "postgres",
  sql: "select :s::jsonb, :n::jsonb, :b::jsonb, :t::jsonb, :z::jsonb, :o::jsonb, :e::jsonb, :l::jsonb[]",
  params: ["s", "n", "b", "t", "z", "o", "e", "l"],
  inputs: { ...Object.fromEntries([..."snbtzoe"].map((k) => [k, { type: { kind: "json" as const } }])), l: { type: { kind: "array", of: { kind: "json" } } } },
};
const jsonValues = { s: "abc", n: 5, b: true, t: '{"a":1}', z: SQL_NULL, o: { d: nativeDriverDate("2026-01-02T03:04:05Z") }, e: [], l: ["x", { a: 1 }, [true]] };
const jsonTexts = ['"abc"', "5", "true", String.raw`"{\"a\":1}"`, SQL_NULL, '{"d":"2026-01-02T03:04:05.000Z"}', "[]", String.raw`{"\"x\"","{\"a\":1}","[true]"}`];

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: a JSON parameter's value is a JavaScript value, which every driver gets as its JSON text, a string as a JSON string, null as NULL", async () => {
  const seen: unknown[][] = [];
  await execute({ query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(values!);
    return { rows: [] };
  }) }, jsonQuery, jsonValues);
  const pgp = { manyOrNone: promiseDriverStub(() => []), query: async (q: any): Promise<any> => {
    seen.push(q.values);
    return [];
  } };
  await execute(pgp, jsonQuery, jsonValues);
  await execute((_sql: string, values?: unknown[]) => {
    seen.push(values!);
    return Promise.resolve([]);
  }, jsonQuery, jsonValues);
  const unsafe = async (_sql: string, values?: unknown[]): Promise<never[]> => {
    seen.push(values!.map((currentValue) => (currentValue !== null && typeof currentValue === "object" ? JSON.stringify(currentValue) : currentValue)));
    return [];
  };
  const bun = { unsafe, commitDistributed: async () => {} };
  await execute({ unsafe }, jsonQuery, jsonValues);
  await execute(bun, jsonQuery, jsonValues);
  // Postgres.js gets each JSON value as its text declared unknown (705), and null as null.
  const unwrap = (v: unknown) => (v !== null && typeof v === "object" ? (assert.equal((v as { type: number }).type, 705), (v as { value: unknown }).value) : v);
  const postgresJs = { unsafe: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(values!.map(unwrap));
    return [];
  }), typed: (value: unknown, type: number) => ({ value, type }) };
  await execute(postgresJs, jsonQuery, jsonValues);
  assert.equal(seen.length, 6);
  Iterator.from(seen).forEach((values) => {assert.deepEqual(values, jsonTexts);});
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql and sqlite: every driver gets a JSON parameter as its JSON text, and null as NULL", async () => {
  const json = { type: { kind: "json" } } as const;
  const mq: QueryModule<"mysql"> = { dialect: "mysql", sql: "select cast(:a as json), cast(:b as json), :name, cast(:a as json), cast(:z as json)", params: ["a", "b", "name", "z"], inputs: { a: json, b: json, z: json, name: { type: { kind: "scalar", name: "text" } } } };
  const values = { a: [1, 2], b: "abc", name: "ada", z: SQL_NULL };
  const expected = ["[1,2]", '"abc"', "ada", "[1,2]", SQL_NULL];
  const seen: unknown[][] = [];
  await execute({ query: promiseDriverStub(() => [[], []] as [unknown, unknown]), execute: promiseDriverStub((_statement: unknown, boundValues?: unknown[]) => {
    seen.push(boundValues!);
    return [[], []] as [unknown, unknown];
  }) }, mq, values);
  await execute({ query: promiseDriverStub((_sql: string, boundValues: unknown) => {
    seen.push(boundValues as unknown[]);
    return [];
  }), batch: promiseDriverStub(() => []) }, mq, values);
  await execute({ unsafe: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(boundValues!);
    return [];
  }), commitDistributed: async () => {} }, mq, values);
  const lq: QueryModule<"sqlite"> = { ...mq, dialect: "sqlite", sql: "select json(:a) as a, json(:b) as b, :name as name, json(:a) as again, json(:z) as z" };
  await execute({ execute: promiseDriverStub((s: { args: unknown[] }) => {
    seen.push(s.args);
    return { rows: [] };
  }), executeMultiple: async () => {} }, lq, values);
  assert.equal(seen.length, 4);
  // Node:sqlite would read an array as its named parameters.
  assert.deepEqual((execute(new DatabaseSync(":memory:"), lq, values) as object[]).map((r) => ({ ...r })), [{ a: "[1,2]", again: "[1,2]", b: '"abc"', name: "ada", z: SQL_NULL }]);
  Iterator.from(seen).forEach((v) => {assert.deepEqual(v, expected);});
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: pg's family, PGlite and Neon, which write any array as an array literal, get an array for a JSON parameter as its JSON text", async () => {
  const seen: unknown[][] = [];
  await execute({ query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(values!);
    return { rows: [] };
  }) }, typed, typedValues);
  const pgp = { manyOrNone: promiseDriverStub(() => []), query: async (q: any): Promise<any> => {
    seen.push(q.values);
    return [];
  } };
  await execute(pgp, typed, typedValues);
  await execute((_sql: string, values?: unknown[]) => {
    seen.push(values!);
    return Promise.resolve([]);
  }, typed, typedValues);
  assert.equal(seen.length, 3);
  Iterator.from(seen).forEach((values) => {assert.deepEqual(values, ['{"1","3"}', "ada", '[1,{"a":"b"}]']);});
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a typed JSON, structured or cast parameter is checked with the checks its module passes, and refused without them", async () => {
  const refusal = (name: string) => ({ name: "TypeError", message: `Parameter "${name}" is a typed JSON, structured or cast parameter, which the run time checks with Reylo's checks; a query defined by hand passes them: defineQuery({ …, checks }) with checks from "@totto2727/reylo".` });
  const client = { query: promiseDriverStub(() => ({ rows: [], rowCount: 0 })) };
  const json: QueryModule<"postgres"> = { dialect: "postgres", sql: "select :p::jsonb", params: ["p"], inputs: { p: { type: { kind: "json" }, schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } } } };
  await assert.rejects(async () => execute(client, json, { p: { n: 1 } }), refusal("p"));
  const db = new DatabaseSync(":memory:");
  const cast: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select cast(:n as integer) as n", params: ["n"], inputs: { n: { type: { kind: "scalar", name: "integer" }, cast: "integer" } } };
  assert.throws(() => executeSync(db, cast, { n: 1 }), refusal("n"));
  // With them, a value the schema or the cast refuses is refused, and one they take is bound.
  await assert.rejects(async () => execute(client, { ...json, checks }, { p: { n: "one" } }), /Parameter "p" at \/n/u);
  assert.deepEqual(await execute(client, { ...json, checks }, { p: { n: 1 } }), []);
  assert.throws(() => executeSync(db, { ...cast, checks }, { n: "one" }), /Parameter "n"/u);
  assert.deepEqual(executeSync(db, { ...cast, checks }, { n: 1 }), [{ n: 1 }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a parameter the statement takes no null for refuses null and refuses to be left out, before the statement runs, and a JSON one takes JSON's null", async () => {
  const seen: unknown[][] = [];
  const client = { query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(values!);
    return { rows: [], rowCount: 0 };
  }) };
  const int4 = { kind: "scalar", name: "int4" } as const;
  const fixtureQuery: QueryModule<"postgres"> = { dialect: "postgres", sql: "select :x::int + 1 as y, :email as email", params: ["x", "email"], inputs: { x: { type: int4, nullable: false }, email: { type: { kind: "scalar", name: "text" }, nullable: true } } };
  await assert.rejects(async () => execute(client, fixtureQuery, { x: SQL_NULL, email: "a" }), { name: "TypeError", message: `Parameter "x" is null, and the statement takes no null for it: pass a value.` });
  await assert.rejects(async () => execute(client, fixtureQuery, { email: "a" }), { name: "TypeError", message: `Parameter "x" is missing, and the statement takes no null for it: pass a value.` });
  assert.throws(() => executeSync(new DatabaseSync(":memory:"), { ...fixtureQuery, dialect: "sqlite", sql: "select :x + 1 as y, :email as email" }, {}), /Parameter "x" is missing/u);
  assert.equal(seen.length, 0);
  // One that takes null binds NULL, given or left out; so does one typed `unknown`, and one a
  // Query defined by hand leaves without `nullable`.
  await execute(client, fixtureQuery, { x: 1 });
  await execute(client, { ...fixtureQuery, inputs: { x: { type: { kind: "unknown" }, nullable: false }, email: { type: int4 } } }, { x: SQL_NULL, email: SQL_NULL });
  assert.deepEqual(seen, [[1, SQL_NULL], [SQL_NULL, SQL_NULL]]);
  // A JSON parameter's null there is JSON's null, which pg gets as the JSON text `null`, unless its
  // Schema, the one it is written with or the one its type carries, refuses null; left out, it is
  // Refused, unless its schema has a default.
  const json = (schema: JsonSchema): QueryModule<"postgres"> => ({ dialect: "postgres", sql: "select :p::jsonb", params: ["p"], inputs: { p: { type: { kind: "json" }, schema, nullable: false } }, checks });
  await assert.rejects(async () => execute(client, json({ type: "integer" }), { p: null }), /Parameter "p" is null/u);
  await assert.rejects(async () => execute(client, json({ type: "integer" }), {}), /Parameter "p" is missing/u);
  await assert.rejects(async () => execute(client, json({ type: ["integer", "null"] }), {}), /Parameter "p" is missing/u);
  await execute(client, json({ type: ["integer", "null"] }), { p: null });
  await execute(client, json({ type: "integer", default: 3 }), {});
  assert.deepEqual(seen.slice(2), [["null"], ["3"]]);
  const untyped = (type: EngineType, nullable = false): QueryModule<"postgres"> => ({ dialect: "postgres", sql: "select :p::jsonb", params: ["p"], inputs: { p: { type, nullable } }, checks });
  await execute(client, untyped({ kind: "json" }), { p: null });
  await assert.rejects(async () => execute(client, untyped({ kind: "json" }), {}), /Parameter "p" is missing/u);
  await execute(client, untyped({ kind: "json", schema: { type: ["integer", "null"] } }), { p: null });
  await assert.rejects(async () => execute(client, untyped({ kind: "json", schema: { type: "integer" } }), { p: null }), /Parameter "p" is null/u);
  // Where the statement takes SQL NULL, a JSON parameter's null is SQL NULL, given or left out.
  await execute(client, untyped({ kind: "json" }, true), { p: null });
  await execute(client, untyped({ kind: "json" }, true), {});
  assert.deepEqual(seen.slice(4), [["null"], ["null"], [SQL_NULL], [SQL_NULL]]);
  // A structured parameter keeps its own message, which says what to pass.
  const rows: QueryModule<"postgres"> = { dialect: "postgres", sql: "select 1", params: ["r"], inputs: { r: { type: { kind: "rows", one: true, fields: [] }, nullable: false } }, checks };
  await assert.rejects(async () => execute(client, rows, { r: null }), /pass one object/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a query without inputs, defined by hand or built before them, binds every array as it is", async () => {
  const { inputs: _inputs, ...bare } = typed;
  const seen: unknown[][] = [];
  const unsafe = async (_sql: string, values?: unknown[]): Promise<never[]> => {
    seen.push(values!);
    return [];
  };
  const bun = { unsafe, commitDistributed: async () => {} };
  await execute(bun, bare, typedValues);
  await execute({ unsafe }, bare, typedValues);
  await execute({ query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(values!);
    return { rows: [] };
  }) }, bare, typedValues);
  Iterator.from(seen).forEach((values) => {assert.deepEqual(values, [[1, 3], "ada", [1, { a: "b" }]]);});
  // Hand-written inputs work through the runtime's own lexer too, a repeated name included.
  const hand: QueryModule<"postgres"> = { dialect: "postgres", sql: "select :ids::int[] = :ids::int[]", params: ["ids"], inputs: { ids: { type: { kind: "array", of: { kind: "scalar", name: "int4" } } } } };
  seen.length = 0;
  await execute({ unsafe }, hand, { ids: [2] });
  assert.deepEqual(seen, [['{"2"}']]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a Date for any date or time parameter, and a string without its zone for a timestamptz one, is refused before the statement runs", async () => {
  const time = (name: string) => ({ type: { kind: "scalar" as const, name } });
  const fixtureQuery: QueryModule<"postgres"> = {
    dialect: "postgres",
    sql: "select :at::timestamp, :day::date, :tz::timestamptz, :tzs::timestamptz[], :days::date[]",
    params: ["at", "day", "tz", "tzs", "days"],
    inputs: { at: time("timestamp"), day: time("date"), tz: time("timestamptz"), tzs: { type: { kind: "array", of: time("timestamptz").type } }, days: { type: { kind: "array", of: time("date").type } } },
  };
  const seen: unknown[][] = [];
  const client = { query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(values!);
    return { rows: [] };
  }) };
  const ok = { at: "2026-10-12 19:06:48.282", day: "2026-10-12", tz: "1970-01-01T00:00:00Z", tzs: ["2026-10-12T19:06:48.282Z", "2026-10-12 19:06:48+09", "2026-10-12 19:06:48.5-07:30", "2026-10-12 19:06 America/Los_Angeles", "2026-10-12 19:06:48 UTC", "infinity", "-infinity", "0001-01-01 00:00:00+00 BC", "+010000-01-01T00:00:00Z"], days: [["2026-10-12"]] };
  await execute(client, fixtureQuery, ok);
  assert.equal(seen.length, 1);
  const refused = async (values: Record<string, unknown>, message: RegExp): Promise<void> => assert.rejects(Promise.resolve().then(() => execute(client, fixtureQuery, { ...ok, ...values })), (error: Error) => error instanceof TypeError && message.test(error.message));
  await refused({ at: nativeDriverDate() }, /^Parameter "at" is a timestamp without a time zone, so it takes the wall-clock text/u);
  await refused({ day: nativeDriverDate() }, /^Parameter "day" is a date without a time zone/u);
  await refused({ days: [[nativeDriverDate()]] }, /^Parameter "days" is a date/u);
  // A timestamptz takes the string `.run()` returns for one, and a Date nowhere.
  await refused({ tz: nativeDriverDate(0) }, /^Parameter "tz" is a timestamptz, which takes the instant as a string that names its zone, as `\.run\(\)` returns one, not a Date: pass date\.toISOString\(\)/u);
  await refused({ tzs: ["2026-10-12T00:00:00Z", nativeDriverDate(0)] }, /^Parameter "tzs" is a timestamptz, .*not a Date/);
  for (const tz of ["2026-10-12 19:06:48", "2026-10-12T19:06:48.282", "2026-10-12"]) {await refused({ tz }, /^Parameter "tz" is a timestamptz, an instant, so a string for it names its zone/u);}
  await refused({ tzs: ["2026-10-12T00:00:00Z", "2026-10-12 19:06"] }, /^Parameter "tzs" is a timestamptz/u);
  // An array parameter takes no null element, as its type says, in any dimension.
  await refused({ tzs: ["2026-10-12T00:00:00Z", SQL_NULL] }, /^Parameter "tzs" is an array whose elements may not be null, and the element at \[1\] is/u);
  await refused({ days: [["2026-10-12", undefined]] }, /^Parameter "days" is an array whose elements may not be null, and the element at \[0\]\[1\] is/u);
  assert.equal(seen.length, 1);
  // MySQL's DATETIME and TIMESTAMP are the engine's timestamp, and a placeholder compared with both is either.
  const my: QueryModule<"mysql"> = { dialect: "mysql", sql: "select :at", params: ["at"], inputs: { at: time("date|timestamp") } };
  await assert.rejects(Promise.resolve().then(() => execute({ query: promiseDriverStub(() => [[], []] as [unknown, unknown]), execute: promiseDriverStub(() => [[], []] as [unknown, unknown]) }, my, { at: nativeDriverDate() })), /^TypeError: Parameter "at" is a timestamp without a time zone/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: postgres.js, which binds a date or time string through new Date(), gets one declared unknown; Bun.sql gets the string", async () => {
  const time = (name: string) => ({ type: { kind: "scalar" as const, name } });
  const fixtureQuery: QueryModule<"postgres"> = { dialect: "postgres", sql: "select :at::timestamp, :day::date, :tz::timestamptz, :d::timestamptz, :name::text", params: ["at", "day", "tz", "d", "name"], inputs: { at: time("timestamp"), day: time("date"), tz: time("timestamptz"), d: time("timestamptz"), name: time("text") } };
  const values = { at: "2026-01-02 03:04:05.006", day: "infinity", tz: "2026-01-02 03:04:05 America/New_York", d: "1970-01-01T00:00:00Z", name: "ada" };
  const seen: unknown[][] = [];
  const unsafe = async (_sql: string, boundValues?: unknown[]): Promise<never[]> => {
    seen.push(boundValues!);
    return [];
  };
  const typed = (value: unknown, type: number) => ({ value, type });
  const postgresJs = { unsafe, typed };
  await execute(postgresJs, fixtureQuery, values);
  const bun = { unsafe, typed, commitDistributed: async () => {} };
  await execute(bun, fixtureQuery, values);
  assert.deepEqual(seen, [
    [{ type: 705, value: "2026-01-02 03:04:05.006" }, { type: 705, value: "infinity" }, { type: 705, value: "2026-01-02 03:04:05 America/New_York" }, { type: 705, value: "1970-01-01T00:00:00Z" }, "ada"],
    ["2026-01-02 03:04:05.006", "infinity", "2026-01-02 03:04:05 America/New_York", "1970-01-01T00:00:00Z", "ada"],
  ]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("what run returns goes back in: a SQLite truth value as 1 or 0, a Postgres extended or BC year in Postgres's own form", async () => {
  const s = (name: string) => ({ type: { kind: "scalar" as const, name } });
  // SQLite: better-sqlite3 refuses a boolean and libSQL binds it as the REAL 1.0.
  const lq: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select :a as a, :b as b, :n as n", params: ["a", "b", "n"], inputs: { a: s("numeric"), b: s("integer"), n: s("integer") } };
  const seen: unknown[][] = [];
  await execute({ execute: promiseDriverStub((st: { args: unknown[] }) => {
    seen.push(st.args);
    return { rows: [] };
  }), executeMultiple: async () => {} }, lq, { a: true, b: false, n: 7 });
  assert.deepEqual([...seen], [[1, 0, 7]]);
  // MySQL's drivers bind a boolean as 1 themselves.
  const mq: QueryModule<"mysql"> = { dialect: "mysql", sql: "select :f as f", params: ["f"], inputs: { f: s("int4") } };
  seen.length = 0;
  await execute({ query: promiseDriverStub(() => [[], []] as [unknown, unknown]), execute: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(boundValues!);
    return [[], []] as [unknown, unknown];
  }) }, mq, { f: true });
  assert.deepEqual([...seen], [[true]]);
  // Postgres refuses `+010000` and the year 0000, which run returns for years past 9999 and 1 BC.
  const pq: QueryModule<"postgres"> = {
    dialect: "postgres",
    sql: "select :far::timestamptz, :bc::timestamptz, :zero::date, :now::timestamptz, :days::date[], :old::timestamp, :huge::date",
    params: ["far", "bc", "zero", "now", "days", "old", "huge"],
    inputs: { far: s("timestamptz"), bc: s("timestamptz"), zero: s("date"), now: s("timestamptz"), days: { type: { kind: "array", of: { kind: "scalar", name: "date" } } }, old: s("timestamp"), huge: s("date") },
  };
  const values = { far: "+010000-01-01T00:00:00Z", bc: "-000001-06-01T12:00:00.5Z", zero: "0000-01-01", now: "2026-10-20T10:00:00Z", days: ["+010000-01-01", "2026-10-20"], old: "-000001-06-01T12:00:00", huge: "+5874897-12-31" };
  seen.length = 0;
  await execute({ query: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(boundValues!);
    return { rows: [] };
  }) }, pq, values);
  assert.deepEqual([...seen], [["10000-01-01T00:00:00Z", "0002-06-01T12:00:00.5Z BC", "0001-01-01 BC", "2026-10-20T10:00:00Z", '{"10000-01-01","2026-10-20"}', "0002-06-01T12:00:00 BC", "5874897-12-31"]]);
  // Postgres refuses a sign before an ISO 8601 duration's `P`, which run returns for a negative interval.
  const iq: QueryModule<"postgres"> = {
    dialect: "postgres",
    sql: "select :back::interval, :ahead::interval, :mixed::interval, :text::interval, :spans::interval[]",
    params: ["back", "ahead", "mixed", "text", "spans"],
    inputs: { back: s("interval"), ahead: s("interval"), mixed: s("interval"), text: s("interval"), spans: { type: { kind: "array", of: { kind: "scalar", name: "interval" } } } },
  };
  seen.length = 0;
  await execute({ query: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(boundValues!);
    return { rows: [] };
  }) }, iq, { back: "-P1DT2H0.5S", ahead: "P1M", mixed: "P1M-1D", text: "-1 days", spans: ["-PT3S", "P1D"] });
  assert.deepEqual([...seen], [["P-1DT-2H-0.5S", "P1M", "P1M-1D", "-1 days", '{"PT-3S","P1D"}']]);
  // Without inputs, as defined by hand, every value goes as it is.
  const { inputs: _inputs, ...bare } = lq;
  seen.length = 0;
  await execute({ execute: promiseDriverStub((st: { args: unknown[] }) => {
    seen.push(st.args);
    return { rows: [] };
  }), executeMultiple: async () => {} }, bare, { a: true, b: false, n: 7 });
  assert.deepEqual([...seen], [[true, false, 7]]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("arrayLiteral writes a Postgres array literal as pg does: nesting, NULL, quotes, backslashes, binary, dates, the empty array", () => {
  assert.equal(arrayLiteral([]), "{}");
  assert.equal(arrayLiteral([1, BigInt("2"), 1.5, true]), '{"1","2","1.5","true"}');
  assert.equal(arrayLiteral([[1, 2], [3, SQL_NULL], []]), '{{"1","2"},{"3",NULL},{}}');
  assert.equal(arrayLiteral([SQL_NULL, undefined, "", "NULL"]), '{NULL,NULL,"","NULL"}');
  assert.equal(arrayLiteral(['say "hi"', String.raw`back\slash`, "a,b", "{x}", " pad "]), String.raw`{"say \"hi\"","back\\slash","a,b","{x}"," pad "}`);
  assert.equal(arrayLiteral([Uint8Array.of(1, 2, 255), Buffer.from([0, 16]), new Uint8Array([9, 171, 9]).subarray(1, 2)]), String.raw`{\\x0102ff,\\x0010,\\xab}`);
  assert.equal(arrayLiteral([{ a: 'q"' }]), String.raw`{"{\"a\":\"q\\\"\"}"}`);
  // Pg's dateToString: the local time, then the offset.
  const d = new Date(2026, 0, 2, 3, 4, 5, 6);
  const offset = -d.getTimezoneOffset();
  const zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  assert.equal(arrayLiteral([d]), `{"2026-01-02T03:04:05.006${zone}"}`);
  // An element type's own delimiter, between sub-arrays too: PostGIS's geometry is `:`.
  assert.equal(arrayLiteral(["0101", SQL_NULL, "0102"], ":"), '{"0101":NULL:"0102"}');
  assert.equal(arrayLiteral([["a"], ["b"]], ";"), '{{"a"};{"b"}}');
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: a pgvector vector parameter takes an array of finite numbers, written as the text pgvector reads; an array of them as an array of those texts", async () => {
  const seen: unknown[][] = [];
  const client = { query: promiseDriverStub((config: { values: unknown[] }) => {
    seen.push(config.values);
    return { rows: [], fields: [] };
  }), getTypeParser: () => String };
  const vector = { kind: "scalar", name: "vector" } as const;
  const nearest: QueryModule<"postgres"> = {
    dialect: "postgres",
    sql: "select id from items where embedding <-> :q < 1 or embedding = any(:qs) or half = :h",
    params: ["q", "qs", "h"],
    inputs: { q: { type: vector }, qs: { type: { kind: "array", of: vector } }, h: { type: { kind: "scalar", name: "halfvec" } } },
  };
  await execute(client as never, nearest, { q: [1, 2.5, -3, 1e-7], qs: [[1, 2], [3]], h: [0.5] });
  assert.deepEqual(seen, [["[1,2.5,-3,1e-7]", '{"[1,2]","[3]"}', "[0.5]"]]);
  // The text pgvector itself prints passes as it is.
  await execute(client as never, nearest, { q: "[1,2]", qs: [], h: SQL_NULL });
  assert.deepEqual(seen.at(-1), ["[1,2]", "{}", SQL_NULL]);
  // JSON would write NaN and ±Infinity as null, and pgvector refuses them and an empty vector.
  for (const [q, why] of [[[1, Number.NaN], /pgvector vector, an array of finite numbers, and the element at \[1\] is NaN/u], [[Infinity], /element at \[0\] is Infinity/u], [["1"], /element at \[0\] is "1"/u], [[], /one dimension at least; got an empty array/u]] as const) {
    await assert.rejects(queryPromise(execute(client as never, nearest, { q, qs: [], h: SQL_NULL })), why);
  }
  await assert.rejects(queryPromise(execute(client as never, nearest, { q: [1], qs: [[1], [Number.NaN]], h: SQL_NULL })), /element at \[0\] is NaN/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: an hstore parameter takes an object of its keys, written as the text hstore reads; an array of them as an array of those texts", async () => {
  const seen: unknown[][] = [];
  const client = { query: promiseDriverStub((config: { values: unknown[] }) => {
    seen.push(config.values);
    return { rows: [], fields: [] };
  }), getTypeParser: () => String };
  const hstore = { kind: "scalar", name: "hstore" } as const;
  const save: QueryModule<"postgres"> = {
    dialect: "postgres",
    sql: "update settings set prefs = :prefs where history = any(:history)",
    params: ["prefs", "history"],
    inputs: { prefs: { type: hstore }, history: { type: { kind: "array", of: hstore } } },
  };
  await execute(client as never, save, { prefs: { theme: "dark", 'q"': "\\", gone: SQL_NULL }, history: [{ a: "1" }, {}] });
  assert.deepEqual(seen, [[String.raw`"theme"=>"dark", "q\""=>"\\", "gone"=>NULL`, String.raw`{"\"a\"=>\"1\"",""}`]]);
  // Its text passes as it is.
  await execute(client as never, save, { prefs: '"a"=>"1"', history: [] });
  assert.deepEqual(seen.at(-1), ['"a"=>"1"', "{}"]);
  await assert.rejects(queryPromise(execute(client as never, save, { prefs: { n: 1 }, history: [] })), /Parameter "prefs" is an hstore, whose values are strings or null, and its key "n" holds 1/u);
  await assert.rejects(queryPromise(execute(client as never, save, { prefs: ["a"], history: [] })), /Parameter "prefs" is an hstore, an object of its keys/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: an array parameter is written with its element type's delimiter, which the module's inputs carry", async () => {
  const seen: unknown[][] = [];
  const client = { query: promiseDriverStub((config: { values: unknown[] }) => {
    seen.push(config.values);
    return { rows: [], fields: [] };
  }), getTypeParser: () => String };
  const shapes: QueryModule<"postgres"> = {
    dialect: "postgres",
    sql: "select id from places where shape = any(:shapes)",
    params: ["shapes"],
    inputs: { shapes: { type: { kind: "array", of: { kind: "scalar", name: "geometry" }, delimiter: ":" } } },
  };
  await execute(client as never, shapes, { shapes: ["0101", "0102"] });
  assert.deepEqual(seen, [['{"0101":"0102"}']]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: Neon's neon() before 1.0 is called with (text, values)", async () => {
  const calls: Call[] = [];
  const sql = (...args: unknown[]) => {
    calls.push({ method: "call", args });
    return Promise.resolve([row]);
  };
  assert.deepEqual(await execute(sql, pg, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(calls[0]!.args.slice(0, 2), ["select $1::int as id, $2 as name, $1 as again", [1, "ada"]]);
  // Its options take a decoder table, 0.9 too, and the fields with fullResults.
  assert.deepEqual(Object.keys(calls[0]!.args[2] as object), ["fullResults", "arrayMode", "types"]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a parameter left out binds NULL, which postgres.js, mysql2, node:sqlite and libSQL would reject", async () => {
  const seen: unknown[][] = [];
  const client = { unsafe: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(values!);
    return [];
  }) };
  await execute(client, pg, { id: 1 });
  await execute(client, { ...pg, text: "select $1, $2", order: ["name", "id"] }, { id: undefined });
  assert.deepEqual(seen, [[1, SQL_NULL], [SQL_NULL, SQL_NULL]]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: execute() → [rows, fields] on mysql2, a repeated name repeated in the values; a write's OK packet gives no rows", async () => {
  const calls: Call[] = [];
  const answers: unknown[] = [[[row], [{ name: "id" }]], [{ affectedRows: 1, insertId: 7 }, undefined]];
  const pool = { query: promiseDriverStub(() => [[], []] as [unknown, unknown]), execute: promiseDriverStub((...args: unknown[]) => {
    calls.push({ method: "execute", args });
    return answers.shift() as [unknown, unknown];
  }) };
  assert.deepEqual(await execute(pool, my, { id: 1, name: "ada" }), [row]);
  // The statement with Reylo's per-query options and typeCast (src/decode-mysql.ts), never decimalNumbers.
  const [options, values] = calls[0]!.args as [Record<string, unknown>, unknown[]];
  assert.deepEqual(values, [1, "ada", 1]);
  assert.deepEqual({ ...options, typeCast: typeof options.typeCast }, { bigNumberStrings: true, dateStrings: true, nestTables: false, rowsAsArray: false, sql: "select ? as id, ? as name, ? as again", supportBigNumbers: true, typeCast: "function" });
  assert.deepEqual(await execute(pool, my, { id: 1, name: "ada" }), []);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: PlanetScale's execute() → { rows }", async () => {
  const conn = { execute: promiseDriverStub(() => ({ rows: [row], statement: "select", headers: ["id"], insertId: "0" })) };
  assert.deepEqual(await execute(conn, my, { id: 1, name: "ada" }), [row]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: mariadb runs through query(), not its own execute(); a write's OK packet gives no rows", async () => {
  const calls: string[] = [];
  const answers: unknown[] = [Object.assign([row], { meta: [] }), { affectedRows: 1, insertId: BigInt("7"), warningStatus: 0 }];
  const conn = {
    query: promiseDriverStub(() => {
      calls.push("query");
      return answers.shift();
    }),
    batch: promiseDriverStub(() => {
      calls.push("batch");
      return {};
    }),
    execute: promiseDriverStub(() => {
      calls.push("execute");
      return [row];
    }),
  };
  assert.deepEqual([...((await execute(conn, my, { id: 1, name: "ada" })) as unknown[])], [row]);
  assert.deepEqual(await execute(conn, my, { id: 1, name: "ada" }), []);
  assert.deepEqual(calls, ["query", "query"]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: mariadb's callback API answers through the callback, and its errors reject", async () => {
  const failure = Object.assign(new Error("Duplicate entry 'a' for key 'email'"), { code: "ER_DUP_ENTRY" });
  const conn = {
    batch: () => ({}),
    // The callback query() returns a command object, not a promise.
    query: (options: { sql: string }, values: unknown[], done: (error: Error | null, rows?: unknown) => void) => {
      setImmediate(() => (options.sql.startsWith("insert") ? done(failure) : done(NO_DRIVER_ERROR, [{ values }])));
      return { on() {} };
    },
  };
  assert.deepEqual(await execute(conn as never, my, { id: 1, name: "ada" }), [{ values: [1, "ada", 1] }]);
  await assert.rejects(() => queryPromise(execute(conn as never, { dialect: "mysql", sql: "insert into t values (:a)", params: ["a"] }, { a: 1 })), (error) => error === failure);
});

// A plain Uint8Array (TextEncoder's, getRandomValues') and a view into a larger buffer, neither a Buffer.
const binary = () => ({ plain: Uint8Array.of(1, 2, 255), view: new Uint8Array([9, 1, 2, 255, 9]).subarray(1, 4) });
const bin: QueryModule<"mysql"> = { dialect: "mysql", sql: "select hex(:plain), hex(:view), hex(:buf), :n", params: ["plain", "view", "buf", "n"] };

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: mariadb, which writes a value that is not a Buffer as JSON, gets a binary value as a Buffer over the same memory", async () => {
  const { plain, view } = binary();
  const buf = Buffer.from([1, 2, 255]);
  for (const api of ["promise", "callback"]) {
    const seen: unknown[][] = [];
    const conn =
      api === "promise"
        ? { batch: promiseDriverStub(() => ({})), query: promiseDriverStub((_sql: string, values: unknown[]) => {
          seen.push(values);
          return [];
        }) }
        : { batch: () => ({}), query: (_sql: string, values: unknown[], done: (error: Error | null, rows?: unknown) => void) => {
          seen.push(values);
          setImmediate(() => done(NO_DRIVER_ERROR, []));
          return { on() {} };
        } };
    await execute(conn as never, bin, { plain, view, buf, n: 1 });
    const [a, b, c, n] = seen[0]!;
    assert.ok(Buffer.isBuffer(a) && Buffer.isBuffer(b), api);
    assert.deepEqual([...(a)], [1, 2, 255]);
    assert.deepEqual([...(b)], [1, 2, 255]);
    // Views, not copies: the same memory at the same offset.
    assert.ok((a).buffer === plain.buffer && (b).buffer === view.buffer && (b).byteOffset === 1);
    assert.equal(c, buf);
    assert.equal(n, 1);
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres: Neon's neon() before 0.10, which sends a Buffer as JSON, gets a binary value in Postgres's hex form", async () => {
  const { plain, view } = binary();
  const seen: unknown[][] = [];
  const sql = (_sql: string, values?: unknown[]): Promise<never[]> => {
    seen.push(values!);
    return Promise.resolve([]);
  };
  const fixtureQuery: QueryModule<"postgres"> = { dialect: "postgres", sql: "select :plain::bytea, :view::bytea, :buf::bytea, :empty::bytea, :n", params: ["plain", "view", "buf", "empty", "n"] };
  await execute(sql, fixtureQuery, { plain, view, buf: Buffer.from([0, 16, 171]), empty: new Uint8Array(0), n: 1 });
  assert.deepEqual(seen[0], [String.raw`\x0102ff`, String.raw`\x0102ff`, String.raw`\x0010ab`, String.raw`\x`, 1]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("every other driver gets a binary value as it is, pg-promise included, since it binds a { text, values } object", async () => {
  const { plain } = binary();
  const seen: unknown[] = [];
  const pgq: QueryModule<"postgres"> = { dialect: "postgres", sql: "select :b::bytea", params: ["b"] };
  const liteq: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select :b", params: ["b"] };
  const pgp = { manyOrNone: promiseDriverStub(() => []), query: async (q: any): Promise<any> => {
    seen.push(q.values[0]);
    return [];
  } };
  await execute(pgp, pgq, { b: plain });
  await execute({ query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(values![0]);
    return { rows: [] };
  }) }, pgq, { b: plain });
  await execute({ unsafe: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(values![0]);
    return [];
  }) }, pgq, { b: plain });
  await execute({ query: promiseDriverStub(() => [[], []] as [unknown, unknown]), execute: promiseDriverStub((_statement: unknown, values?: unknown[]) => {
    seen.push(values![0]);
    return [[], []] as [unknown, unknown];
  }) }, { ...bin, sql: "select hex(:b)", params: ["b"] }, { b: plain });
  await execute({ prepare: () => ({ all: (...values: unknown[]) => {
    seen.push(values[0]);
    return [];
  } }) }, liteq, { b: plain });
  assert.equal(seen.length, 5);
  Iterator.from(seen).forEach((v) => {assert.equal(v, plain);});
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a binary parameter takes binary data alone, so base64 text is refused before the statement runs", async () => {
  const { plain } = binary();
  const bytes = (name: string) => ({ type: { kind: "scalar" as const, name } });
  const fixtureQuery: QueryModule<"postgres"> = { dialect: "postgres", sql: "select :b::bytea, :bs::bytea[]", params: ["b", "bs"], inputs: { b: bytes("bytea"), bs: { type: { kind: "array", of: bytes("bytea").type } } } };
  const seen: unknown[][] = [];
  const client = { query: promiseDriverStub((_sql: string, values?: unknown[]) => {
    seen.push(values!);
    return { rows: [] };
  }) };
  await execute(client, fixtureQuery, { b: Buffer.from([1]), bs: [plain] });
  await execute(client, fixtureQuery, { b: SQL_NULL, bs: SQL_NULL });
  assert.equal(seen.length, 2);
  const refused = async (run: () => unknown, message: RegExp): Promise<void> => assert.rejects(Promise.resolve().then(run), (error: Error) => error instanceof TypeError && message.test(error.message));
  await refused(() => execute(client, fixtureQuery, { b: "AQL/", bs: [] }), /^Parameter "b" is binary data, so it takes a Uint8Array \(a Buffer is one\), as `\.run\(\)` returns one; got "AQL\/"\. Decode base64 or hex text into one first\.$/u);
  await refused(() => execute(client, fixtureQuery, { b: plain, bs: [plain, String.raw`\x01`] }), /^Parameter "bs" is binary data, .*got "\\\\x01"/);
  await refused(() => execute(client, fixtureQuery, { b: plain.buffer, bs: [] }), /^Parameter "b" is binary data, .*got an object\. Wrap an ArrayBuffer in one: new Uint8Array\(buffer\)\.$/);
  assert.equal(seen.length, 2);
  // MySQL's BINARY, VARBINARY and BLOB are the engine's bytea; SQLite's BLOB is blob.
  const my: QueryModule<"mysql"> = { dialect: "mysql", sql: "select :b", params: ["b"], inputs: { b: bytes("bytea") } };
  await refused(() => execute({ query: promiseDriverStub(() => [[], []] as [unknown, unknown]), execute: promiseDriverStub(() => [[], []] as [unknown, unknown]) }, my, { b: "AQL/" }), /^Parameter "b" is binary data/u);
  const lite: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select :b", params: ["b"], inputs: { b: bytes("blob") } };
  await refused(() => execute({ prepare: () => ({ all: () => [] }) }, lite, { b: "AQL/" }), /^Parameter "b" is binary data/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: PlanetScale 2.0, which binds no parameters, runs a statement without any and refuses one with some", async () => {
  const calls: unknown[][] = [];
  // 2.0's execute(query, options) refuses anything past them, or a second argument that is not its options.
  const conn = {
    execute: promiseDriverStub((...args: unknown[]) => {
      calls.push(args);
      if (args.length > 2 || (!matchesNullish(args[1]) && (typeof args[1] !== "object" || Array.isArray(args[1])))) {throw new Error("Query parameters are not supported: pass a complete SQL string and options to execute(query, options)");}
      return { rows: [row], statement: String(args[0]), headers: [] };
    }),
  };
  assert.deepEqual(await execute(conn, { dialect: "mysql", sql: "select 1", params: [] }), [row]);
  await assert.rejects(() => queryPromise(execute(conn, my, { id: 1, name: "ada" })), (error: TypeError) => error instanceof TypeError && /2\.0 binds no parameters/u.test(error.message) && /not supported/u.test((error.cause as Error).message));
  // 1.x's form first, then 2.0's, with Reylo's cast either way.
  assert.deepEqual(calls[0]!.slice(0, 2), ["select 1", null]);
  assert.deepEqual([calls[1]![0], Object.keys(calls[1]![1] as object)], ["select 1", ["as", "cast"]]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: a mysql2 callback pool or connection runs through its promise() wrapper", async () => {
  const callback = {
    // The callback execute() returns a Query object, not a promise.
    execute: () => ({ on() {} }),
    promise: () => ({ query: promiseDriverStub(() => [[], []] as [unknown, unknown]), execute: promiseDriverStub(() => [[row], []] as [unknown, unknown]) }),
  };
  assert.deepEqual(await execute(callback, my, { id: 1, name: "ada" }), [row]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql: Bun.sql's unsafe()", async () => {
  assert.deepEqual(await execute({ unsafe: promiseDriverStub(() => [row]), commitDistributed: async () => {} }, my, { id: 1, name: "ada" }), [row]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: node:sqlite answers at once, with one ? per placeholder; a write gives no rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table t (a int)");
  const rows = execute(db, lite, { id: 1, name: "ada" });
  assert.ok(Array.isArray(rows), "a synchronous client's rows are not a promise");
  assert.deepEqual(rows.map((currentRow) => ({ ...(currentRow as object) })), [row]);
  assert.deepEqual(execute(db, { dialect: "sqlite", sql: "insert into t values (:a)", params: ["a"] }, { a: 2 }), []);
  assert.deepEqual(db.prepare("select a from t").all().map((r) => ({ ...r })), [{ a: 2 }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: better-sqlite3's statement that returns no rows is run(), since its all() throws", () => {
  const calls: Call[] = [];
  const db = {
    prepare: (sql: string) => ({
      reader: !sql.startsWith("insert"),
      all: (...args: unknown[]) => {
        if (sql.startsWith("insert")) {throw new TypeError("This statement does not return data. Use run() instead");}
        calls.push({ method: "all", args });
        return [row];
      },
      run: (...args: unknown[]) => {
        calls.push({ method: "run", args });
        return { changes: 1 };
      },
    }),
  };
  assert.deepEqual(execute(db, { dialect: "sqlite", sql: "insert into t values (:a)", params: ["a"] }, { a: 2 }), []);
  assert.deepEqual(execute(db, lite, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(calls, [{ args: [2], method: "run" }, { args: [1, "ada", 1], method: "all" }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Cloudflare D1's prepare(sql).bind(...values).all() → { results }", async () => {
  const bound: unknown[][] = [];
  const d1 = {
    batch: promiseDriverStub(() => []),
    prepare: () => ({ first: promiseDriverStub(() => NO_ROW), bind: (...values: unknown[]) => {
      bound.push(values);
      return { all: promiseDriverStub(() => ({ results: [row], success: true, meta: {} })) };
    } }),
  };
  const rows = execute(d1, lite, { id: 1, name: "ada" });
  assert.ok(rows instanceof Promise);
  assert.deepEqual(await rows, [row]);
  assert.deepEqual(bound, [[1, "ada", 1]]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: @libsql/client and its transactions take execute({ sql, args }) → { rows }", async () => {
  const calls: unknown[] = [];
  const tx = { execute: promiseDriverStub((stmt: { sql: string; args: unknown[] }) => {
    calls.push(stmt);
    return { rows: [row], columns: ["id"], rowsAffected: 0 };
  }), executeMultiple: async () => {}, commit: async () => {} };
  assert.deepEqual(await execute(tx, lite, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(calls, [{ args: [1, "ada", 1], sql: "select ? as id, ? as name, ? as again" }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Turso's @tursodatabase/database, its Database in every release and its Transaction, takes prepare(sql).all(...values) → a promise of rows; its compat Database answers at once", async () => {
  const calls: unknown[] = [];
  // Its statement, as every release from 0.4 has it: safeIntegers(), a promise from all(), close().
  const statement = (sql: string) => {
    const st = {
      safe: undefined as boolean | undefined,
      closed: false,
      safeIntegers: (on: boolean) => {
        st.safe = on;
        return st;
      },
      all: promiseDriverStub((...values: unknown[]) => {
        calls.push({ sql, values, safe: st.safe });
        return [row];
      }),
      close: () => void (st.closed = true),
      get reader(): boolean {
        throw new Error("not implemented"); // 0.4's
      },
    };
    return st;
  };
  const statements: ReturnType<typeof statement>[] = [];
  const prepare = (sql: string) => {
    statements.push(statement(sql));
    return statements.at(-1)!;
  };
  const common = { connect: async () => {}, maxWriteReplicationIndex: () => {}, exec: async () => {}, prepare };
  // 0.4: no all() on the database, so it looked synchronous; 0.6 and later: all() and exec(), so it looked like sqlite3's.
  const v04 = { ...common };
  const v08 = { ...common, all: promiseDriverStub(() => []), batch: promiseDriverStub(() => []), transactionAsync: () => {} };
  const tx = { prepare, exec: async () => {}, all: promiseDriverStub(() => []), batch: promiseDriverStub(() => []), run: promiseDriverStub(() => ({})) };
  for (const client of [v04, v08, tx]) {
    const pending = execute(client as never, lite, { id: 1, name: "ada" });
    assert.ok(pending instanceof Promise);
    assert.deepEqual(await pending, [row]);
  }
  assert.deepEqual(calls, Array(3).fill({ sql: "select ? as id, ? as name, ? as again", values: [1, "ada", 1], safe: true }), "a statement whose columns are not typed reads integers exact");
  assert.ok(statements.every((st) => st.closed), "each statement is closed after its run");
  // A module whose every column is typed reads numbers, as better-sqlite3's statement does.
  await execute(v08 as never, { ...lite, columns: [["id", "int"], ["name", "text"], ["again", "int"]] }, { id: 1, name: "ada" });
  assert.equal((calls.at(-1) as { safe: boolean }).safe, false);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  await assert.rejects(Promise.resolve().then(() => defineQuery<{}, unknown, "many", "sqlite">({ dialect: "sqlite", sql: "select 1", params: [] }).runSync(v08 as never)), /runSync takes a synchronous SQLite client .*answers through a promise/);
  // The compat Database (@tursodatabase/database/compat) has batch() as D1 does, and answers at once.
  // It gets a statement per call, closed after it (0.4's, run a second time, lost a subquery's rows).
  let prepared = 0;
  let closed = 0;
  const compat = {
    prepare: (sql: string) => {
      prepared++;
      return { reader: true, safeIntegers: () => {}, all: (...values: unknown[]) => {
        calls.push({ sql, values });
        return [row];
      }, close: () => void closed++ };
    },
    batch: () => [],
    exec: () => {},
    maxWriteReplicationIndex: () => {},
  };
  const query = defineQuery<{ id: number; name: string }, unknown, "many", "sqlite">({ dialect: "sqlite", sql: lite.sql, params: lite.params });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(query.runSync(compat, { id: 2, name: "bo" }), [row]);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(query.runSync(compat, { id: 2, name: "bo" }), [row]);
  assert.deepEqual(calls.at(-1), { sql: "select ? as id, ? as name, ? as again", values: [2, "bo", 2] });
  assert.deepEqual([prepared, closed], [2, 2]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: sqlite3 and the sqlite package, which bind a BigInt as NULL, get one a number holds as that number, a larger one its digits where the parameter is a BIGINT column's, and is refused elsewhere", async () => {
  const seen: unknown[][] = [];
  const sqlite3 = { all: (_sql: string, boundValues: unknown[], cb: (error: Error | null, rows: unknown[]) => void) => {
    seen.push(boundValues);
    return cb(NO_DRIVER_ERROR, []);
  }, exec: () => {} };
  const sqlite = { all: promiseDriverStub((_sql: string, boundValues?: unknown[]) => {
    seen.push(boundValues!);
    return [];
  }), getDatabaseInstance: () => ({}) };
  await execute(sqlite3, lite, { id: BigInt(7), name: "ada" });
  await execute(sqlite, lite, { id: BigInt(-7), name: "ada" });
  assert.deepEqual([...seen], [[7, "ada", 7], [-7, "ada", -7]]);
  for (const client of [sqlite3, sqlite]) {await assert.rejects(Promise.resolve().then(() => execute(client, lite, { id: BigInt("9007199254740993"), name: "ada" })), /^TypeError: sqlite3 binds a BigInt as NULL, and 9007199254740993 is past 2\^53 - 1/u);}
  assert.equal(seen.length, 2);
  // A BIGINT column's parameter (the engine's int8), whose INTEGER affinity reads the digits as that integer.
  const big: QueryModule<"sqlite"> = { ...lite, inputs: { id: { type: { kind: "scalar", name: "int8" } }, name: { type: { kind: "scalar", name: "text" } } } };
  await execute(sqlite3, big, { id: BigInt("9007199254740993"), name: "ada" });
  await execute(sqlite, big, { id: BigInt("-9007199254740993"), name: "ada" });
  assert.deepEqual([...seen].slice(2), [["9007199254740993", "ada", "9007199254740993"], ["-9007199254740993", "ada", "-9007199254740993"]]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: sqlite3's callback all(), its errors, and the sqlite package's promise all()", async () => {
  const failure = Object.assign(new Error("SQLITE_ERROR: near \"selec\": syntax error"), { code: "SQLITE_ERROR" });
  const sqlite3 = {
    prepare: () => ({}),
    exec: () => {},
    all: (sql: string, values: unknown[], done: (error: Error | null, rows: unknown[]) => void) => setImmediate(() => (sql.includes("selec ") ? done(failure, []) : done(NO_DRIVER_ERROR, [{ values }]))),
  };
  assert.deepEqual(await execute(sqlite3, lite, { id: 1, name: "ada" }), [{ values: [1, "ada", 1] }]);
  await assert.rejects(() => queryPromise(execute(sqlite3, { dialect: "sqlite", sql: "selec 1", params: [] })), (error) => error === failure);
  const wrapper = { getDatabaseInstance: () => sqlite3, prepare: promiseDriverStub(() => ({})), all: promiseDriverStub((_sql: string, values: unknown[]) => [{ values }]) };
  assert.deepEqual(await execute(wrapper, lite, { id: 2, name: "bo" }), [{ values: [2, "bo", 2] }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("sqlite: Bun.sql's SQLite adapter, which has unsafe() and no prepare()", async () => {
  assert.deepEqual(await execute({ unsafe: promiseDriverStub(() => [row]), commitDistributed: async () => {} }, lite, { id: 1, name: "ada" }), [row]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the driver's own error comes through unchanged", async () => {
  const duplicate = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  await assert.rejects(() => queryPromise(execute({ query: promiseDriverStub(() => { throw duplicate; }) }, pg, { id: 1 })), (error) => error === duplicate);
  const db = new DatabaseSync(":memory:");
  assert.throws(() => execute(db, { dialect: "sqlite", sql: "selec 1", params: [] }), /syntax error/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an unsupported client rejects, naming what it has and what reylo takes", async () => {
  await assert.rejects(() => queryPromise(execute({ connect() {}, end() {} } as never, pg)), (error: TypeError) => error instanceof TypeError && /postgres statement on an object with connect, end\. It takes a client with query\(text, values\)/u.test(error.message));
  // An object with Drizzle's select() but no session over a client is no Drizzle database.
  await assert.rejects(() => queryPromise(execute({ $client: {}, select() {} } as never, pg)), /object with select\. .*or a Drizzle database over one of them\./);
  // Kysely and Prisma decode their values themselves, so each is told to pass the driver's client.
  class Kysely { public selectFrom(): void {} public executeQuery(): void {} public transaction(): void {} }
  await assert.rejects(() => queryPromise(execute(new Kysely() as never, pg)), /object with selectFrom, executeQuery, transaction\. .* Kysely decodes the values of its queries itself: pass the pool or database its dialect was made with\.$/);
  await assert.rejects(() => queryPromise(execute({ $queryRawUnsafe() {}, $transaction() {} } as never, my)), / Prisma decodes the values of its queries itself: pass a client of your database's driver, such as the pool its driver adapter was made with\.$/u);
  // Inside their transactions, neither hands out the connection.
  await assert.rejects(() => queryPromise(execute(Object.assign(new Kysely(), { isTransaction: true }) as never, pg)), / Kysely decodes the values of its queries itself and does not hand out its transaction's connection: take the transaction from the driver's client instead\.$/u);
  await assert.rejects(() => queryPromise(execute({ $queryRawUnsafe() {} } as never, lite)), / Prisma decodes the values of its queries itself and does not hand out its transaction's connection/u);
  // Node:sqlite's tag store has all() for templates; it is not sqlite3's database.
  const store = new DatabaseSync(":memory:").createTagStore();
  await assert.rejects(() => queryPromise(execute(store as never, lite, { id: 1, name: "ada" })), /sqlite statement on an object with .*pass its database, store\.db/);
  await assert.rejects(() => queryPromise(execute(null as never, my)), /mysql statement on null/u);
  // The refusal names every client a MySQL statement runs on, mariadb's among them.
  await assert.rejects(() => queryPromise(execute({} as never, my)), /query\(text, values\) as on mariadb's pool or connection, from its promise or callback API/u);
  // A pg pool handed to a SQLite statement matches no SQLite shape.
  await assert.rejects(() => queryPromise(execute({ query: promiseDriverStub(() => ({ rows: [] })) } as never, lite)), /sqlite statement on an object with query/u);
});

// A SQLite-backed Durable Object's ctx.storage.sql, as workerd's answers
// (lab/driver-matrix/probes/durable-object.mjs): exec() runs at once and returns a cursor; a BigInt
// Binding throws; an INTEGER comes back as a number, rounded past 2^53; a BLOB as an ArrayBuffer.
const durableObjectSql = function durableObjectSql(db: DatabaseSync) {
  return {
    exec(sql: string, ...bindings: unknown[]) {
      if (bindings.some((binding) => typeof binding === "bigint")) {throw new TypeError("Cannot convert a BigInt value to a number");}
      const st = db.prepare(sql);
      st.setReadBigInts(true);
      const rows = st.all(...(bindings as never[])).map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : (value instanceof Uint8Array ? value.slice().buffer : value)])),
      );
      return { toArray: () => rows, columnNames: rows.length ? Object.keys(rows[0]!) : [] };
    },
    get databaseSize() {
      return 4096;
    },
  };
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a Drizzle database or transaction runs on the driver client its session keeps", async () => {
  // Drizzle's database and transaction objects: select() beside a session holding the dialect and the client.
  const drizzle = <C>(client: C) => ({ $client: client, select() {}, execute() {}, session: { dialect: {}, client } });
  const seen: unknown[][] = [];
  const pgClient = { query: promiseDriverStub((_sql: string, values: unknown[]) => {
    seen.push(values);
    return { rows: [row] };
  }) };
  assert.deepEqual(await execute(drizzle(pgClient) as never, pg, { id: 1, name: "ada" }), [row]);
  const mysqlPool = { query: promiseDriverStub(() => [[], []]), execute: promiseDriverStub((_statement: unknown, values: unknown[]) => {
    seen.push(values);
    return [[row], []];
  }) };
  assert.deepEqual(await execute(drizzle(mysqlPool) as never, my, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(seen, [[1, "ada"], [1, "ada", 1]]);
  const db = new DatabaseSync(":memory:");
  assert.deepEqual(executeSync(drizzle(db) as never, lite, { id: 1, name: "ada" }), [row]);
  // Drizzle-orm/durable-sqlite keeps the Durable Object's storage, ctx.storage, whose SQL storage is its sql.
  const storage = { sql: durableObjectSql(new DatabaseSync(":memory:")), transactionSync: (fn: () => unknown) => fn() };
  assert.deepEqual(executeSync(drizzle(storage) as never, lite, { id: 1, name: "ada" }), [row]);
  assert.deepEqual(await execute(drizzle(storage) as never, lite, { id: 1, name: "ada" }), [row]);
  // Inside a libSQL transaction the session keeps the base client on client and the transaction on tx.
  const libsql = (name: string) => ({ execute: promiseDriverStub(() => {
    seen.push([name]);
    return { rows: [row], columns: ["id", "name", "again"], columnTypes: [] };
  }), batch: promiseDriverStub(() => []), transaction: async () => {} });
  const tx = { select() {}, session: { dialect: {}, client: libsql("base"), tx: { ...libsql("tx"), commit: async () => {}, rollback: async () => {} } } };
  await execute(tx as never, lite, { id: 1, name: "ada" });
  assert.deepEqual(seen.at(-1), ["tx"]);
  // A MySQL client whose execute() answers without PlanetScale's rows, as TiDB Cloud's transaction inside
  // Drizzle-orm/tidb-serverless answers with the rows themselves, is refused rather than read as no rows.
  const tidb = { $client: {}, select() {}, rollback() {}, session: { dialect: {}, client: { execute: promiseDriverStub(() => [row]) } } };
  await assert.rejects(() => queryPromise(execute(tidb as never, my, { id: 1, name: "ada" })), /^TypeError: reylo ran this statement through execute\(\), as on PlanetScale's @planetscale\/database, and the client answered with an array rather than a result with rows\./u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("positional placeholders take an object keyed by number, bound by number on every dialect", async () => {
  const seen: [string, unknown[]][] = [];
  const pgClient = { query: promiseDriverStub((text: string, values: unknown[]) => {
    seen.push([text, values]);
    return { rows: [] };
  }) };
  const mysqlPool = { query: promiseDriverStub(() => [[], []] as [unknown, unknown]), execute: promiseDriverStub((options: { sql: string }, values: unknown[]) => {
    seen.push([options.sql, values]);
    return [[], []] as [unknown, unknown];
  }) };
  const d1 = { batch: promiseDriverStub(() => []), prepare: (text: string) => ({ first: promiseDriverStub(() => NO_ROW), bind: (...values: unknown[]) => {
    seen.push([text, values]);
    return { all: promiseDriverStub(() => ({ results: [] })) };
  } }) };
  const positional: Record<string, QueryModule> = {
    postgres: { dialect: "postgres", sql: "select $2::text as name, $1::int as id", params: ["1", "2"] },
    mysql: { dialect: "mysql", sql: "select ? as id, ? as name", params: ["1", "2"] },
    sqlite: { dialect: "sqlite", sql: "select ?1 as id, ?2 as name, ?1 as again", params: ["1", "2"] },
  };
  for (const [client, dialect] of [[pgClient, "postgres"], [mysqlPool, "mysql"], [d1, "sqlite"]] as const) {await execute(client as never, positional[dialect]!, { 1: 1, 2: "ada" });}
  assert.deepEqual(seen, [
    ["select $2::text as name, $1::int as id", [1, "ada"]],
    ["select ? as id, ? as name", [1, "ada"]],
    ["select ? as id, ? as name, ? as again", [1, "ada", 1]],
  ]);
  // The mapper's rewritten statement binds by `order`, which names params.
  const unsafe: unknown[][] = [];
  await execute({ unsafe: promiseDriverStub((_sql: string, values: unknown[]) => {
    unsafe.push(values);
    return [];
  }) }, { ...pg, text: "select $1, $2, $1", order: ["name", "id", "name"] }, { id: 1, name: "ada" });
  assert.deepEqual(unsafe, [["ada", 1, "ada"]]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an array of parameters is refused before anything runs, with a TypeError that says to pass an object", async () => {
  const calls: unknown[] = [];
  const client = { unsafe: promiseDriverStub((...args: unknown[]) => {
    calls.push(args);
    return [];
  }) };
  const named = /^TypeError: The parameters must be an object keyed by parameter name, or by number for positional placeholders \(\{ 1: \.\.\., 2: \.\.\. \}\); got an array\. This statement takes \{ id: \.\.\., name: \.\.\. \}\.$/u;
  const refused = (re: RegExp) => (error: Error) => error instanceof TypeError && re.test(String(error));
  // A freshness check would be a round trip: the array is refused before it too.
  await assert.rejects(() => queryPromise(execute(client, { ...pg, fresh: { query: "select 1", rows: [], inserts: [] } }, [1, "ada"] as never)), refused(named));
  const positional: QueryModule<"postgres"> = { dialect: "postgres", sql: "select $1::int, $2::text", params: ["1", "2"] };
  await assert.rejects(() => queryPromise(execute(client, positional, [1, "ada"] as never)), refused(/got an array\. This statement takes \{ 1: \.\.\., 2: \.\.\. \}\.$/u));
  await assert.rejects(() => queryPromise(execute(client, pg, "ada" as never)), refused(/positional placeholders \(\{ 1: \.\.\., 2: \.\.\. \}\); got ada\. This statement takes \{ id: \.\.\., name: \.\.\. \}\.$/u));
  await assert.rejects(() => queryPromise(execute(client, pg, null as never)), refused(/got null\./u));
  assert.deepEqual(calls, []);
  // On a synchronous SQLite client the TypeError is thrown.
  const db = new DatabaseSync(":memory:");
  assert.throws(() => execute(db, lite, [1, "ada"] as never), refused(named));
  assert.throws(() => execute(db, { dialect: "sqlite", sql: "select 1", params: [] }, [] as never), refused(/got an array\. This statement takes none: leave them out\.$/u));
  // Through the query object: run and with reject, runSync throws, and the types refuse it too.
  const currentQuery = defineQuery<{ id: number; name: string }, { id: number; name: string; again: number }, "one", "sqlite">({ dialect: "sqlite", sql: lite.sql, params: lite.params, cardinality: "one" });
  // @ts-expect-error the parameters are an object, never an array
  await assert.rejects(() => currentQuery.run(db, [1, "ada"]), refused(named));
  // @ts-expect-error the parameters are an object, never an array
  await assert.rejects(() => currentQuery.with(db)([1, "ada"]), refused(named));
  // @ts-expect-error the parameters are an object, never an array
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => currentQuery.runSync(db, [1, "ada"]), refused(named));
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual({ ...(currentQuery.runSync(db, { id: 1, name: "ada" }) as object) }, row);
  const p = defineQuery<{ 1: number; 2: string }, { id: number }, "one", "postgres">({ dialect: "postgres", sql: positional.sql, params: positional.params, cardinality: "one" });
  // @ts-expect-error positional placeholders take an object keyed by number
  await assert.rejects(() => p.run(client, [1, "ada"]), refused(/This statement takes \{ 1: \.\.\., 2: \.\.\. \}\./u));
  db.close();
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("runSync: on a synchronous client the value comes back at once and an error is thrown, so db.transaction(fn) rolls back", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table users (id integer primary key, email text unique)");
  const insert = defineQuery<{ email: string }, { id: number }, "one", "sqlite">({ dialect: "sqlite", sql: "insert into users (email) values (:email) returning id", params: ["email"], cardinality: "one" });
  const count = defineQuery<{}, { n: number }, "one", "sqlite">({ dialect: "sqlite", sql: "select count(*) as n from users", params: [], cardinality: "one" });
  // Better-sqlite3's and bun:sqlite's transaction(fn): BEGIN, the function, then COMMIT, or ROLLBACK if it throws.
  const transaction = (fn: () => void): void => {
    db.exec("begin");
    try {
      fn();
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  };
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  const first = insert.runSync(db, { email: "ada@example.com" });
  assert.equal(first.id, 1);
  assert.throws(() => transaction(() => {
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    insert.runSync(db, { email: "bo@example.com" });
    // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
    insert.runSync(db, { email: "ada@example.com" }); // The unique constraint fails here
  }), /UNIQUE constraint failed/u);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.equal(count.runSync(db).n, 1, "the transaction's first insert was rolled back");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => defineQuery<{}, unknown, "one", "sqlite">({ dialect: "sqlite", sql: "select 1 where 0", params: [], cardinality: "one" }).runSync(db), /Expected exactly one row, got 0/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("run: on a synchronous client the statement runs at once, and its rows and its error still come through the promise", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table users (id integer primary key, email text unique)");
  const insert = defineQuery<{ email: string }, { id: number }, "one", "sqlite">({ dialect: "sqlite", sql: "insert into users (email) values (:email) returning id", params: ["email"], cardinality: "one" });
  const pending = insert.run(db, { email: "ada@example.com" });
  assert.ok(pending instanceof Promise);
  assert.equal((db.prepare("select count(*) as n from users").get() as { n: number }).n, 1, "the insert ran before run returned");
  assert.equal((await pending).id, 1);
  let duplicate: unknown;
  assert.doesNotThrow(() => void (duplicate = insert.run(db, { email: "ada@example.com" })));
  await assert.rejects(queryPromise(duplicate), /UNIQUE constraint failed/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("runSync: a client that answers through a promise, or a Postgres or MySQL statement, is refused before anything runs", () => {
  let called = false;
  const libsql = { execute: promiseDriverStub(() => {
    called = true;
    return { rows: [] };
  }), executeMultiple: async () => {} };
  const lite = defineQuery<{}, unknown, "many", "sqlite">({ dialect: "sqlite", sql: "select 1", params: [] });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => lite.runSync(libsql as never), /runSync takes a synchronous SQLite client .*answers through a promise\. run takes every client/);
  const pgq = defineQuery<{}, unknown, "many", "postgres">({ dialect: "postgres", sql: "select 1", params: [] });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => pgq.runSync({ query: promiseDriverStub(() => {
    called = true;
    return { rows: [] };
  }) } as never), /a postgres statement has none/u);
  assert.equal(called, false);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("run: on an asynchronous client every failure is a rejection, never a throw", async () => {
  const currentQuery = defineQuery<{ id: number }, { id: number }, "maybeOne", "postgres">({ dialect: "postgres", sql: "select :id::int as id", params: ["id"], cardinality: "maybeOne" });
  const two = { query: promiseDriverStub(() => ({ rows: [{ id: 1 }, { id: 2 }] })) };
  let returned: unknown;
  assert.doesNotThrow(() => void (returned = currentQuery.run(two, { id: 1 })));
  await assert.rejects(queryPromise(returned), /Expected at most one row, got 2/u);
  await assert.rejects(currentQuery.run({} as never, { id: 1 }), TypeError);
  assert.deepEqual(await currentQuery.with({ query: promiseDriverStub(() => ({ rows: [] })) })({ id: 1 }), NO_ROW);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a query's source names its file, and Reylo's own errors about the query start with it", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table users (id integer primary key, email text unique)");
  const one = defineQuery<{}, unknown, "one", "sqlite">({ dialect: "sqlite", sql: "select 1 where 0", params: [], cardinality: "one", source: "queries/none.sql" });
  assert.equal(one.source, "queries/none.sql");
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => one.runSync(db), /^Error: queries\/none\.sql: Expected exactly one row, got 0$/mu);
  await assert.rejects(one.run(db), { message: "queries/none.sql: Expected exactly one row, got 0" });
  // A parameter's value: thrown in runSync, rejected by run, the stack's first line named too.
  const at = defineQuery<{ at: string }, unknown, "many", "postgres">({ dialect: "postgres", sql: "select :at::timestamptz as at", params: ["at"], inputs: { at: { type: { kind: "scalar", name: "timestamptz" } } }, source: "at.sql" });
  const rejected = await at.run({ query: promiseDriverStub(() => ({ rows: [] })) }, { at: "2026-10-12 19:06:48" }).then(() => undefined, (error: Error) => error);
  assert.ok(rejected instanceof TypeError);
  assert.match(rejected.message, /^at\.sql: Parameter "at" is a timestamptz/u);
  assert.match(rejected.stack!, /^TypeError: at\.sql: Parameter "at"/u);
  const viaWith = await at.with({ query: promiseDriverStub(() => ({ rows: [] })) })({ at: nativeDriverDate() as never }).then(() => undefined, (error: Error) => error);
  assert.match(viaWith!.stack!, /^TypeError: at\.sql: Parameter "at" is a timestamptz, which takes the instant as a string/u);
  // A column's value Reylo cannot give its kind.
  const truth = defineQuery<{}, unknown, "many", "sqlite">({ dialect: "sqlite", sql: "select 2 as b", params: [], columns: [["b", "bool"]], source: "truth.sql" });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => truth.runSync(db), (error: Error) => error instanceof TypeError && error.message.startsWith('truth.sql: Column "b" is a boolean'));
  await assert.rejects(truth.run(db), (error: Error) => error.message.startsWith('truth.sql: Column "b" is a boolean'));
  // The driver's own error passes through as it is.
  const insert = defineQuery<{ email: string }, unknown, "none", "sqlite">({ dialect: "sqlite", sql: "insert into users (email) values (:email)", params: ["email"], cardinality: "none", source: "insert.sql" });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  insert.runSync(db, { email: "ada@example.com" });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => insert.runSync(db, { email: "ada@example.com" }), (error: Error) => error.message.startsWith('UNIQUE constraint failed'));
  await assert.rejects(insert.run(db, { email: "ada@example.com" }), (error: Error) => error.message.startsWith('UNIQUE constraint failed'));
  // A query defined by hand, with no file, keeps its messages as they are.
  const bare = defineQuery<{}, unknown, "one", "sqlite">({ dialect: "sqlite", sql: "select 1 where 0", params: [], cardinality: "one" });
  assert.equal(bare.source, undefined);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => bare.runSync(db), { message: "Expected exactly one row, got 0" });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a Durable Object's ctx.storage.sql: runSync and run take it, its values given their kinds", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table items (id integer primary key, n integer, big bigint, data blob, flag boolean, doc json)");
  const sql = durableObjectSql(db);
  const insert = defineQuery<{ n: bigint; big: bigint; data: Uint8Array; flag: boolean; doc: unknown }, { id: number }, "one", "sqlite">({
    dialect: "sqlite",
    sql: "insert into items (n, big, data, flag, doc) values (:n, :big, :data, :flag, :doc) returning id",
    params: ["n", "big", "data", "flag", "doc"],
    cardinality: "one",
    inputs: { big: { type: { kind: "scalar", name: "int8" } } },
    columns: [["id", "int"]],
  });
  const select = defineQuery<{ id: number }, unknown, "one", "sqlite">({
    dialect: "sqlite",
    sql: "select n, big, data, flag, doc from items where id = :id",
    params: ["id"],
    cardinality: "one",
    columns: [["n", "int"], ["big", "int8"], ["data", "bytes"], ["flag", "bool"], ["doc", "json"]],
  });
  // A BigInt a number holds goes as that number; one past 2^53 to a BIGINT column as its digits.
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  const { id } = insert.runSync(sql, { n: BigInt("5"), big: BigInt("2") ** BigInt("53") + BigInt("1"), data: new Uint8Array([1, 2]), flag: true, doc: '{"a":1}' });
  assert.equal(id, 1);
  assert.deepEqual({ ...db.prepare("select n, cast(big as text) as big, typeof(big) as t, flag from items").get() }, { big: "9007199254740993", flag: 1, n: 5, t: "integer" });
  // Read back, that BIGINT comes as a rounded number, which Reylo refuses rather than return.
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => select.runSync(sql, { id }), /Column "big" is a 64-bit integer, and the driver already rounded its value/u);
  const second = await insert.run(sql, { n: BigInt("6"), big: BigInt("7"), data: new Uint8Array([3]), flag: false, doc: "[]" });
  assert.deepEqual(await select.run(sql, second), { n: 6, big: BigInt("7"), data: new Uint8Array([3]), flag: false, doc: [] });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(select.runSync(sql, second), { n: 6, big: BigInt("7"), data: new Uint8Array([3]), flag: false, doc: [] });
  // A BigInt past 2^53 anywhere else is refused before it reaches exec().
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => insert.runSync(sql, { n: BigInt("2") ** BigInt("53"), big: BigInt("1"), data: new Uint8Array(), flag: true, doc: "1" }), /^TypeError: A Durable Object's SQL storage binds no BigInt, and 9007199254740992 is past 2\^53 - 1/u);
  // A write without returning gives no rows.
  const touch = defineQuery<{}, unknown, "none", "sqlite">({ dialect: "sqlite", sql: "update items set n = n + 1", params: [], cardinality: "none" });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.equal(touch.runSync(sql), undefined);
  assert.equal((db.prepare("select sum(n) as s from items").get() as { s: number }).s, 13);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a Durable Object's ctx.storage.sql: the catalog facts are read again through exec()", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table users (id integer primary key, email text not null)");
  const sql = durableObjectSql(db);
  const query = "select j.value as fresh_table, p.name as fresh_column, p.type as fresh_type, cast(p.\"notnull\" as text) as fresh_not_null, cast(p.dflt_value is not null or (p.pk > 0 and lower(p.type) = 'integer' and (select count(*) from pragma_table_xinfo(j.value) k where k.pk > 0) = 1) as text) as fresh_default from (select 'users' as value) j, pragma_table_xinfo(j.value) p order by 1, 2";
  const built = (email: string[]) =>
    defineQuery<{}, unknown, "many", "sqlite">({ dialect: "sqlite", sql: "select id, email from users", params: [], fresh: { query, rows: [email, ["users", "id", "INTEGER", "0", "1"]], inserts: [] }, source: "users.sql" });
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.deepEqual(built(["users", "email", "TEXT", "1", "0"]).runSync(sql), []);
  // oxlint-disable-next-line rules/no-effect-runtime-run -- This test exercises Reylo's native synchronous query API, which does not run Effect.
  assert.throws(() => built(["users", "email", "TEXT", "0", "0"]).runSync(sql), /^Error: The database changed after users\.sql was built: users\.email was/u);
  // Run takes the same synchronous path: the check and the statement run before it returns.
  const ran: string[] = [];
  const counted = { ...sql, exec: (text: string, ...bindings: unknown[]) => {
    ran.push(text);
    return sql.exec(text, ...bindings);
  }, databaseSize: 4096 };
  const pending = built(["users", "email", "TEXT", "1", "0"]).run(counted);
  assert.deepEqual(ran, [query, "select id, email from users"]);
  assert.deepEqual(await pending, []);
});
