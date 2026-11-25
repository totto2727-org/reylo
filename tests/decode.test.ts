// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { execute } from '#reylo-source/execute.ts';
import type { QueryModule } from '#reylo-source/execute.ts';
import { parseArray } from "#reylo-source/decode.ts";
import { nativeDriverDate, promiseDriverStub, SQL_NULL, requireFixtureValue } from "./helpers.ts";
import { asyncDriverMarker, driverMarker, driverPromise, driverRow, executeFixture } from "./driver-fixtures.ts";
import { hasObjectType, isEmptyArray, isRecord, matchesUndefined } from "#reylo-source/native-predicates.ts";

import {
  appTable, built, COLUMNS, database, lateProbe, pgClient, pgPool, pglite, postgresJs, probe,
  ROLE_ARR, ROLE, POSINT_ARR, PAIR_ARR, SHAPE_ARR, VEC, VEC_ARR, HSTORE, HSTORE_ARR, same,
} from "./postgres-driver-fixture.ts";
import type { Config, Parser, PgFixtureClient, PgFixtureResult } from "./postgres-driver-fixture.ts";

/** What Reylo returns for each column: src/values.ts. */
const declared = {
  amounts: ["1.5", "12345678901234567890.1"],
  at: "2024-01-15T08:30:00.123456Z",
  big: BigInt("9007199254740993"),
  boxes: ["(1,1),(0,0)", "(2,2),(1,1)"],
  bytes: Uint8Array.from([1, 2, 255]),
  day: "2024-01-15",
  doc: { a: [1, 2] },
  embedding: [1, 2.5, -3, 1e-7],
  embeddings: [[1, 2], SQL_NULL, [3]],
  flag: true,
  history: [{ a: "1" }, SQL_NULL, {}],
  ints: [1, SQL_NULL],
  names: ["a", "b"],
  nothing: SQL_NULL,
  pairs: '{"(1,x)"}',
  posints: [1, 2],
  prefs: { a: "1", "b c": SQL_NULL, 'q"': "\\" },
  role: "admin",
  roles: ["admin", "member", SQL_NULL],
  shapes: ["0101", SQL_NULL, "0102"],
  span: "P1Y2M",
  spans: ["P1D", "PT2H"],
  wall: "2024-01-15T10:30:00.123456",
};
// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("parseArray: quoting, escapes, NULL, nesting, bounds and box's delimiter", () => {
  assert.deepEqual(parseArray("{}", String), []);
  assert.deepEqual(parseArray(String.raw`{a,"b,c","NULL",NULL,"","q\"x\\y"}`, String), ["a", "b,c", "NULL", SQL_NULL, "", String.raw`q"x\y`]);
  assert.deepEqual(parseArray("{{1,2},{3,NULL}}", Number), [[1, 2], [3, SQL_NULL]]);
  assert.deepEqual(parseArray("[0:1]={7,8}", Number), [7, 8]);
  assert.deepEqual(parseArray(String.raw`{"(1,x)","(2,\"y,z\")"}`, String), ["(1,x)", '(2,"y,z")']);
  assert.deepEqual(parseArray("{(1,1),(0,0);(2,2),(1,1)}", String, ";"), ["(1,1),(0,0)", "(2,2),(1,1)"]);
});

const checkAppDecoding = async function (client: PgFixtureClient): Promise<Record<string, unknown>> {
  const original = await client.query("select * from probe");
  const control = driverRow(original.rows[0]);
  // The failing control: the app's own table, whose int8 parser returns the text.
  assert.equal(control.big, "9007199254740993");
  assert.equal(control.at, "app:2024-01-15 10:30:00.123456+02");
  assert.equal(control.day, "client:2024-01-15");
  assert.equal(control.roles, "{admin,member,NULL}");
  assert.deepEqual(control.span, { interval: "1 year 2 mons" });
  return control;
};
const checkUnchangedControl = async function (client: PgFixtureClient, control: Record<string, unknown>): Promise<void> {
  const after = await client.query("select * from probe");
  assert.deepEqual(after.rows[0], control, "the app's own queries keep its parsers");
  const sent = client.calls.find((call) => isRecord(call) && call.text === "select * from probe where id = $1");
  assert.deepEqual(driverRow(sent).values, [1]);
};
const checkCatalogCache = async function (client: PgFixtureClient, catalogQueries: string[]): Promise<void> {
  assert.equal(catalogQueries.length, 1);
  assert.match(requireFixtureValue(catalogQueries[0]), new RegExp(`any\\('\\{${ROLE_ARR},${ROLE},${POSINT_ARR},${PAIR_ARR},${SHAPE_ARR},${VEC},${VEC_ARR},${HSTORE},${HSTORE_ARR}\\}'`, "u"));
  await execute(client, probe, { id: 1 });
  assert.equal(catalogQueries.length, 1, "what the catalog said is kept per client");
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("pg Client: Reylo's table answers every oid, so no parser of the app's applies to its query, and the app's next query is unchanged", async () => {
  const db = database();
  const client = pgClient(db);
  client.setTypeParser(1082, (text) => `client:${text}`);
  client.setTypeParser(ROLE, (text) => text.toUpperCase());
  const control = await checkAppDecoding(client);
  // A query defined by hand: the types the database created through one catalog query.
  const [row] = await execute(client, probe, { id: 1 });
  same(row, declared);
  await checkCatalogCache(client, db.catalogQueries);
  await checkUnchangedControl(client, control);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("pg Client: a module's columns give the created types their kinds, so no catalog query runs", async () => {
  const db = database();
  const client = pgClient(db);
  const [row] = await execute(client, built, { id: 1 });
  same(row, declared);
  assert.equal(db.catalogQueries.length, 0);
  // What the columns said is kept for the client, delimiter and all, for a query defined by hand.
  const cached = await execute(client, probe, { id: 1 });
  same(cached[0], declared);
  assert.equal(db.catalogQueries.length, 0);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("pg Client: a type created after Reylo read the catalog comes back decoded, after one lookup of that oid", async () => {
  const db = database();
  const client = pgClient(db);
  await execute(client, probe, { id: 1 });
  db.late();
  const [row] = await execute(client, lateProbe, { id: 1 });
  assert.deepEqual([driverRow(row).lates, driverRow(row).late], [["x", "y"], "x"]);
  assert.equal(db.catalogQueries.length, 2);
  assert.match(requireFixtureValue(db.catalogQueries[1]), /any\('\{70030,70031\}'::pg_catalog\.oid\[\]\)/u);
  await execute(client, lateProbe, { id: 1 });
  assert.equal(db.catalogQueries.length, 2, "a learned oid is not looked up again");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("pg: a client set up with binary: true is refused, before the query and if pg asks for a binary parser", async () => {
  const db = database();
  const binary = pgClient(db, { binary: true });
  await assert.rejects(driverPromise(execute(binary, built, { id: 1 })), /binary: true .*pg 8 reads wrong/u);
  // Pg.defaults.binary, which the client does not show: pg asks the table for the binary format.
  const sneaky = pgClient(db, { binary: true });
  Object.defineProperty(sneaky, "binary", { get: () => false });
  const asked: string[] = [];
  const original = sneaky.query;
  sneaky.query = async (config: string | Config, values?: unknown[]) => {
    if (hasObjectType(config) && config.types) {
      const {types} = config;
      const request = { ...config, types: { getTypeParser: (oid: number) => {
        asked.push("binary");
        return types.getTypeParser(oid, "binary");
      } } };
      return original(request, values);
    }
    return original(config, values);
  };
  await assert.rejects(driverPromise(execute(sneaky, built, { id: 1 })), /binary: true/u);
  assert.ok(!isEmptyArray(asked));
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("pg Pool: pool.query with Reylo's table, so a connect listener's parsers do not apply either", async () => {
  const db = database();
  const pool = pgPool(db);
  pool.on("connect", (connection: PgFixtureClient) => {connection.setTypeParser(1184, (text) => `conn:${text}`);});
  const [row] = await execute(pool, built, { id: 1 });
  same(row, declared);
  const [called] = requireFixtureValue(pool.clients[0]).calls;
  assert.ok(isRecord(driverRow(called).types), "the statement went through pool.query with types");
  pool.options.binary = true;
  await assert.rejects(driverPromise(execute(pool, built, { id: 1 })), /binary: true/u);
});

interface ReceivedRows { data: Record<string, unknown>[] }
type Receive = (event: ReceivedRows) => void;
interface PgPromiseFixture {
  manyOrNone: () => Promise<unknown[]>;
  query: (config: Config) => Promise<PgFixtureResult["rows"]>;
  result: (config: Config) => Promise<PgFixtureResult>;
}

const makePgPromise = function (conn: PgFixtureClient, calls: unknown[]): (receive?: Receive) => PgPromiseFixture {
  return (receive?: Receive): PgPromiseFixture => ({
    manyOrNone: promiseDriverStub(() => []),
    query: async (config: Config): Promise<PgFixtureResult["rows"]> => {
      calls.push(config);
      const result = await conn.query(config);
      return result.rows;
    },
    result: async (config: Config): Promise<PgFixtureResult> => {
      calls.push(config);
      const result = await conn.query(config);
      receive?.({ data: result.rows.map((row) => driverRow(row)) });
      return result;
    },
  });
};

const camel = (event: ReceivedRows): void => {
  event.data.forEach((receivedRow) => {
    Object.keys(receivedRow).forEach((key) => {
      receivedRow[key.toUpperCase()] = receivedRow[key];
      Reflect.deleteProperty(receivedRow, key);
    });
  });
};

const checkPgPromiseReceive = async function (make: (receive?: Receive) => PgPromiseFixture, calls: unknown[]): Promise<void> {
  // On the database the receive event can be read: refused before anything runs.
  const withReceive = Object.assign(make(camel), { $config: { options: { receive: camel } } });
  const before = calls.length;
  await assert.rejects(driverPromise(executeFixture(withReceive, built, { id: 1 })), /receive event rewrites every result/u);
  assert.equal(calls.length, before);
  // A task exposes no options; a receive that renamed the columns is caught by the rows' keys.
  const task = make(camel);
  await assert.rejects(driverPromise(executeFixture(task, built, { id: 1 })), /receive event rewrites every result/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("pg-promise: result({ text, values, types }) on the database, a task and a transaction; its receive event is refused", async () => {
  const db = database();
  const conn = pgClient(db);
  const calls: unknown[] = [];
  const make = makePgPromise(conn, calls);
  const pgp = Object.assign(make(), { $config: { options: {} } });
  const [row] = await executeFixture(pgp, built, { id: 1 });
  same(row, declared);
  const bound = driverRow(calls.at(-1));
  assert.deepEqual(Object.keys(bound), ["text", "values", "types"]);
  await checkPgPromiseReceive(make, calls);
});

const checkPgliteParsers = async function (lite: ReturnType<typeof pglite>, statement: QueryModule<"postgres">): Promise<void> {
  const first = new Set(Object.keys(requireFixtureValue(lite.seen[0])).map(Number));
  assert.ok(first.has(20) && first.has(1082) && first.has(POSINT_ARR) && first.has(ROLE), "a first run names every oid the instance parses");
  await executeFixture(lite, statement, { id: 1 });
  const learned = new Set(Object.keys(requireFixtureValue(lite.seen[1])).map(Number));
  assert.deepEqual(learned, new Set(COLUMNS.map(([, oid]) => oid)), "a later run names only the statement's oids");
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("PGlite: per-query parsers that name the statement's oids, every oid the instance parses on a first run; a transaction too", async () => {
  const db = database();
  // The instance's table: the app's parsers, and PGlite's array parsers built at start.
  const instance: Record<number, Parser> = { ...appTable, 1082: (text) => nativeDriverDate(text), 1184: (text) => nativeDriverDate(text), [POSINT_ARR]: (text) => parseArray(text, String), [ROLE]: (text) => text.toUpperCase() };
  const lite = pglite(db, instance);
  const statement = { ...built, sql: "select * from probe where id = :id -- pglite" };
  const [row] = await executeFixture(lite, statement, { id: 1 });
  same(row, declared);
  await checkPgliteParsers(lite, statement);
  // A transaction exposes no table; what it does not name went through the instance's parser, and is decoded from what it gave.
  const [inTx] = await executeFixture(pglite(db), { ...built, sql: "select * from probe where id = :id -- tx" }, { id: 1 });
  same(inTx, declared);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Neon's neon(): query(text, params, { fullResults, types }), which replaces Neon's whole table", async () => {
  const db = database();
  const conn = pgClient(db);
  const calls: unknown[][] = [];
  const neon = Object.assign(promiseDriverStub(() => {
    assert.fail("This callable client must use its query method");
  }), {
    query: async (text: string, values: unknown[], options: { fullResults?: boolean; arrayMode?: boolean; types?: Config["types"] }) => {
      calls.push([text, values, options]);
      const result = await conn.query({ text, values, ...(matchesUndefined(options.types) ? {} : { types: options.types }), ...(options.arrayMode === true ? { rowMode: "array" } : {}) });
      return options.fullResults === true ? result : result.rows;
    },
    transaction: driverMarker,
    unsafe: () => ({}),
  });
  const [row] = await executeFixture(neon, probe, { id: 1 });
  same(row, declared);
  const options = driverRow(requireFixtureValue(calls[0])[2]);
  assert.deepEqual(Object.keys(options), ["fullResults", "arrayMode", "types"]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("postgres.js: .raw() and Reylo's text parsers, the rows built with the module's names, which a column transform does not rename", async () => {
  const db = database();
  // The fake's columns are upper-cased, as an app's transform.column would rename them.
  const [row] = await executeFixture(postgresJs(db), built, { id: 1 });
  same(row, declared);
  // A query defined by hand has the server's names, and the catalog for the created types.
  const [bare] = await executeFixture(postgresJs(db), probe, { id: 1 });
  assert.deepEqual(driverRow(bare).ROLES, declared.roles);
  const transformed = postgresJs(db, (transformedRow) => [...transformedRow, "ROW-TRANSFORMED"]);
  await assert.rejects(driverPromise(executeFixture(transformed, built, { id: 1 })), /transform\.row rewrites every row/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Bun.sql: its values are given their kinds after the fact", async () => {
  const bunRow = {
    at: nativeDriverDate("2024-01-15T08:30:00Z"),
    big: BigInt("9007199254740993"),
    day: nativeDriverDate("2024-01-15T00:00:00Z"),
    embedding: "[1,2.5]",
    far: nativeDriverDate("+012345-06-01T12:00:00Z"),
    forever: Infinity,
    ints: Int32Array.of(1, 2),
    old: nativeDriverDate("-000043-03-15T12:00:00Z"),
    prefs: '"a"=>"1"',
    roles: "{admin,member}",
    shapes: "{0101:0102}",
    wall: nativeDriverDate("2024-01-15T10:30:00.120Z"),
  };
  const bun = { commitDistributed: asyncDriverMarker, unsafe: promiseDriverStub(() => [{ ...bunRow }]) };
  const statement: QueryModule<"postgres"> = { ...probe, columns: [["big", "int8"], ["day", "date"], ["wall", "timestamp"], ["old", "timestamp"], ["far", "timestamp"], ["ints", "int[]"], ["roles", "text[]"], ["shapes", "text[]", ":"], ["embedding", "vector"], ["prefs", "hstore"], ["at", "timestamptz"], ["forever", "date"]] };
  // The failing control: Bun.sql's timestamptz is a Date; Reylo's the instant's text, to Bun's millisecond.
  assert.ok(bunRow.at instanceof Date);
  assert.deepEqual(await execute(bun, statement, { id: 1 }), [{ at: "2024-01-15T08:30:00Z", big: BigInt("9007199254740993"), day: "2024-01-15", embedding: [1, 2.5], far: "+012345-06-01T12:00:00", forever: "infinity", ints: [1, 2], old: "-000043-03-15T12:00:00", prefs: { a: "1" }, roles: ["admin", "member"], shapes: ["0101", "0102"], wall: "2024-01-15T10:30:00.12" }]);
  // Without bigint: true, Bun's int8 is its text.
  const plain = { commitDistributed: asyncDriverMarker, unsafe: promiseDriverStub(() => [{ at: nativeDriverDate("2024-01-15T08:30:00.5Z"), big: "9007199254740993" }]) };
  assert.deepEqual(await execute(plain, { ...probe, columns: [["big", "int8"], ["at", "timestamptz"]] }, { id: 1 }), [{ at: "2024-01-15T08:30:00.5Z", big: BigInt("9007199254740993") }]);
  // A query defined by hand: a typed array an array, and a Date, which no value is, the instant's text.
  assert.deepEqual(await execute(bun, probe, { id: 1 }), [{ ...bunRow, at: "2024-01-15T08:30:00Z", day: "2024-01-15T00:00:00Z", far: "+012345-06-01T12:00:00Z", ints: [1, 2], old: "-000043-03-15T12:00:00Z", wall: "2024-01-15T10:30:00.12Z" }]);
});
