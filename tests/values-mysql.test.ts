// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Compare native decoder and driver results with the test runner's assertions.
import assert from "node:assert/strict";
import { execute } from '#reylo-source/execute.ts';
import type { QueryModule } from '#reylo-source/execute.ts';
import type { Columns } from "#reylo-source/values.ts";
import { forEachFixtureInOrder, promiseDriverStub, NO_DRIVER_ERROR, SQL_NULL, requireFixtureValue } from "./helpers.ts";
import { asyncDriverMarker, driverMarker, driverPromise, executeFixture } from "./driver-fixtures.ts";
import type { PlanetScaleCast, PlanetScaleOptions } from "./driver-fixtures.ts";
import { hasFunctionType, matchesNull } from "#reylo-source/native-predicates.ts";

type NativeFields = Record<string, unknown>;

interface MySqlField {
  buffer: () => Buffer | null;
  string: () => string | null;
  type: string;
}
type MySqlCast = (column: MySqlField, next: () => unknown) => unknown;

const field = (type: string, text: string | null): MySqlField => ({
  buffer: () => matchesNull(text) ? SQL_NULL : Buffer.from(text),
  string: () => text,
  type,
});

const readMysql2Cast = (value: unknown): MySqlCast => {
  assert.ok(hasFunctionType(value), "Mysql2 expects a result decoder");
  return (column, next): unknown => {
    const decoded: unknown = Reflect.apply(value, undefined, [column, next]);
    return decoded;
  };
};

const selected = (columns?: Columns): QueryModule<"mysql"> => ({
  ...(columns ? { columns } : {}),
  dialect: "mysql",
  params: [],
  sql: "select 1",
});

interface EmptyRows { rows: unknown[]; statement: string }

const asWireBytes = (text: string): string => Buffer.from(text, "utf8").toString("latin1");

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql2: per-query options and Reylo's typeCast, never decimalNumbers; a DECIMAL and JSON as their text, a date's dropped fraction and its T, TIME's digits", async () => {
  const calls: NativeFields[] = [];
  const pool = {
    // Mysql2 calls the typeCast once per value with the field and its own reading, and resolves to [rows, fields].
    execute: promiseDriverStub((options: NativeFields) => {
      calls.push(options);
      const cast = readMysql2Cast(options.typeCast);
      const row = Object.fromEntries([
        ["amount", cast(field("NEWDECIMAL", "1.100000000000000001"), () => 1.1)],
        ["doc", cast(field("JSON", '{"big":9007199254740993}'), () => ({ big: "9007199254740993" }))],
        ["at", cast(field("DATETIME", SQL_NULL), () => "2026-03-08 09:31:00")],
        ["at6", cast(field("DATETIME", SQL_NULL), () => "2026-03-08 09:31:00.123456")],
        ["latest", cast(field("DATETIME", SQL_NULL), () => "2026-03-08 09:31:00")],
        ["t", cast(field("TIME", SQL_NULL), () => "10:00:00.5")],
        ["geo", cast(field("GEOMETRY", "wkb"), () => ({ x: 1, y: 2 }))],
        ["big", cast(field("LONGLONG", SQL_NULL), () => "9007199254740993")],
      ]);
      const fields = [["amount", 246, 18], ["doc", 245, 0], ["at", 12, 3], ["at6", 12, 6], ["latest", 12, 0], ["t", 11, 2], ["geo", 255, 0], ["big", 8, 0]].map(([name, columnType, decimals]) => ({ columnType, decimals, name }));
      return [[row], fields];
    }),
    query: promiseDriverStub(() => [[], []]),
  };
  const [row] = await executeFixture(pool, selected());
  // A BIGINT's exact text a BigInt, by the result's own column type (LONGLONG).
  assert.deepEqual(row, { amount: "1.100000000000000001", at: "2026-03-08T09:31:00.000", at6: "2026-03-08T09:31:00.123456", big: BigInt("9007199254740993"), doc: { big: 9_007_199_254_740_992 }, geo: Buffer.from("wkb"), latest: "2026-03-08T09:31:00", t: "10:00:00.50" });
  const sent = requireFixtureValue(calls[0]);
  assert.equal("decimalNumbers" in sent, false, "a per-query decimalNumbers poisons mysql2's parser cache for every pool");
  assert.equal("jsonStrings" in sent, false);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mariadb: every option per query, metaAsArray off, a SET joined and a DATETIME's T; a GEOMETRY read as bytes only where a column may hold one", async () => {
  const calls: NativeFields[] = [];
  const meta = [{ isSet: () => true, name: () => "tags", type: "SET" }, { isSet: () => false, name: () => "at", type: "DATETIME" }, { isSet: () => false, name: () => "id", type: "INT" }];
  const conn = {
    batch: promiseDriverStub(() => ({})),
    query: promiseDriverStub((options: NativeFields) => {
      calls.push(options);
      return Object.assign([{ at: "2026-03-08 09:31:00.000", id: 1, tags: ["x", "z"] }], { meta });
    }),
  };
  assert.deepEqual([...(await executeFixture(conn, selected()))], [{ at: "2026-03-08T09:31:00.000", id: 1, tags: "x,z" }]);
  const sent = requireFixtureValue(calls[0]);
  assert.equal(sent.metaAsArray, false);
  // A BIGINT mariadb's own BigInt, a DECIMAL its text, on mariadb 3 and mariadb 2 (supportBigInt, bigNumberStrings).
  assert.deepEqual([sent.bigIntAsNumber, sent.supportBigNumbers, sent.decimalAsNumber, sent.supportBigInt, sent.bigNumberStrings], [false, false, false, true, true]);
  assert.equal(sent.typeCast, undefined, "an app's typeCast is switched off");
  await executeFixture(conn, selected([["shape", "unknown"]]));
  assert.equal(typeof requireFixtureValue(calls[1]).typeCast, "function");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("PlanetScale: Reylo's cast per query, the driver's own default with a DATETIME's T, over the app's", async () => {
  const casts: PlanetScaleCast[] = [];
  const conn = {
    execute: promiseDriverStub((_sql: string, _values?: unknown, options?: PlanetScaleOptions): EmptyRows => {
      casts.push(requireFixtureValue(options).cast);
      return { rows: [], statement: "" };
    }),
  };
  await execute(conn, selected());
  const cast = requireFixtureValue(casts[0]);
  assert.deepEqual(
    [cast({ type: "INT64" }, "9007199254740993"), cast({ type: "DATETIME" }, "2026-03-08 09:31:00.000"), cast({ type: "DECIMAL" }, "1.10"), cast({ type: "JSON" }, asWireBytes('{"é":1}')), cast({ type: "INT32" }, "7"), cast({ type: "FLOAT64" }, "2.2"), cast({ charset: 63, type: "VARBINARY" }, "\u0001ÿ"), cast({ charset: 255, type: "VARCHAR" }, asWireBytes("é")), cast({ type: "INT64" }, SQL_NULL)],
    [BigInt("9007199254740993"), "2026-03-08T09:31:00.000", "1.10", { é: 1 }, 7, 2.2, Uint8Array.of(1, 255), "é", SQL_NULL],
  );
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mariadb's callback API, whose rows carry no meta, and mariadb 2, whose columns have no isSet(): the module's kinds join a SET and give a DATETIME its T", async () => {
  const conn = {
    batch: () => ({}),
    query: (_statement: unknown, __: unknown, done: (error: Error | null, rows?: unknown, meta?: unknown) => void) => {
      setImmediate(() => {done(NO_DRIVER_ERROR, [{ at: "2026-03-08 09:31:00.000", id: 1, tags: ["x", "z"] }], [{ name: () => "tags", type: "SET" }]);});
      return { on: driverMarker };
    },
  };
  const fixtureQuery: QueryModule<"mysql"> = { columns: [["tags", "text"], ["at", "timestamp"], ["id", "int"]], dialect: "mysql", params: [], sql: "select 1" };
  assert.deepEqual(await executeFixture(conn, fixtureQuery), [{ at: "2026-03-08T09:31:00.000", id: 1, tags: "x,z" }]);
  // A query defined by hand: the callback's own meta.
  assert.deepEqual(await executeFixture(conn, { ...fixtureQuery, columns: undefined }), [{ at: "2026-03-08 09:31:00.000", id: 1, tags: "x,z" }]);
});

type MysqlReply = [unknown, unknown];
type MysqlQuery = () => Promise<MysqlReply>;

interface CastPool {
  execute: (options: { typeCast: unknown }) => Promise<MysqlReply>;
  pool: { config: { connectionConfig: NativeFields } } | undefined;
  query: MysqlQuery;
}

const castPool = (sent: unknown[], connectionConfig: NativeFields | undefined): CastPool => ({
  execute: promiseDriverStub((options: { typeCast: unknown }) => {
    sent.push(hasFunctionType(options.typeCast) ? "cast" : options.typeCast);
    return [[], []];
  }),
  pool: connectionConfig && { config: { connectionConfig } },
  query: promiseDriverStub(() => [[], []]),
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql2: Reylo's typeCast only where it is needed, since mysql2 calls it for every value: a JSON or unknown column, unknown columns, or the app's typeCast, decimalNumbers or jsonStrings", async () => {
  const sent: unknown[] = [];
  const cases: [options: NativeFields | undefined, columns?: Columns][] = [
    [{}, [["n", "int8"], ["amount", "decimal"], ["at", "timestamp"]]],
    [{}, [["doc", "json"]]],
    [{}, [["shape", "unknown"]]],
    [{}],
    [{ decimalNumbers: true }, [["amount", "decimal"]]],
    [{ jsonStrings: true }, [["n", "int"]]],
    [{ typeCast: () => SQL_NULL }, [["n", "int"]]],
    [undefined, [["n", "int"]]],
  ];
  await forEachFixtureInOrder(cases, async ([options, columns]) => {
    await executeFixture(castPool(sent, options), selected(columns));
  });
  assert.deepEqual(sent, [true, "cast", "cast", "cast", "cast", "cast", "cast", "cast"]);
});

const mysql2Row = (done: unknown): NativeFields => ({
  done, either: 2.5, n: "9007199254740993", one_bit: Buffer.of(1), same: "0", widened: 7,
});

interface Mysql2Fixture {
  execute: MysqlQuery;
  query: MysqlQuery;
}

const mysql2 = (done: unknown): Mysql2Fixture => {
  const fields = [["done", 1], ["same", 8], ["one_bit", 16], ["n", 8], ["widened", 3], ["either", 5]].map(([name, columnType]) => ({ columnType, decimals: 0, name }));
  return {
    execute: promiseDriverStub(() => [[mysql2Row(done)], fields]),
    query: promiseDriverStub(() => [[], []]),
  };
};

const checkMysql2Truth = async function (query: QueryModule<"mysql">, expected: NativeFields[]): Promise<void> {
  assert.deepEqual(await executeFixture(mysql2(1), query), expected);
  const invalid = mysql2(2);
  await assert.rejects(driverPromise(executeFixture(invalid, query)), /^TypeError: Column "done" is a boolean, stored as 0 or 1, and holds 2, which is neither/u);
  // A hand-written query has no column types. The driver still reports BIGINT's native type.
  assert.deepEqual(await executeFixture(mysql2(2), { ...query, columns: undefined }), [{ ...mysql2Row(2), n: BigInt("9007199254740993"), same: BigInt("0") }]);
};

interface MariadbFixture {
  batch: () => Promise<object>;
  query: () => Promise<NativeFields[]>;
}

const mariadb = (done: unknown): MariadbFixture => ({
  batch: promiseDriverStub(() => ({})),
  query: promiseDriverStub(() => [{ ...mysql2Row(done), n: BigInt("9007199254740993"), same: BigInt("0") }]),
});

const bun = (done: unknown): { commitDistributed: typeof asyncDriverMarker; unsafe: () => Promise<NativeFields[]> } => ({
  commitDistributed: asyncDriverMarker,
  unsafe: promiseDriverStub(() => [{ ...mysql2Row(done), one_bit: true }]),
});

const planetTruthRow = (done: string, cast: PlanetScaleCast): NativeFields => Object.fromEntries([
  ["done", cast({ type: "INT8" }, done)],
  ["same", cast({ type: "INT64" }, "0")],
  ["one_bit", cast({ charset: 63, type: "BIT" }, "\u0001")],
  ["n", cast({ type: "INT64" }, "9007199254740993")],
  ["widened", cast({ type: "INT32" }, "7")],
  ["either", cast({ type: "FLOAT64" }, "2.5")],
]);

interface PlanetScaleFixture {
  execute: (sql: string, values: unknown, options: PlanetScaleOptions) => Promise<EmptyRows>;
}

const planetscale = (done: string): PlanetScaleFixture => ({
  execute: promiseDriverStub((_sql: string, _values: unknown, options: PlanetScaleOptions) => ({
    rows: [planetTruthRow(done, options.cast)],
    statement: "",
  })),
});

const checkOtherTruthDrivers = async function (query: QueryModule<"mysql">, expected: NativeFields[]): Promise<void> {
  assert.deepEqual([...(await executeFixture(mariadb(1), query))], expected);
  const invalidMaria = mariadb(-1);
  await assert.rejects(driverPromise(executeFixture(invalidMaria, query)), /Column "done" is a boolean, stored as 0 or 1, and holds -1/u);
  assert.deepEqual(await executeFixture(planetscale("1"), query), expected);
  const invalidPlanet = planetscale("2");
  await assert.rejects(driverPromise(executeFixture(invalidPlanet, query)), /Column "done" is a boolean/u);
  assert.deepEqual(await executeFixture(bun(1), query), expected);
  const invalidBun = bun(5);
  await assert.rejects(driverPromise(executeFixture(invalidBun, query)), /Column "done" is a boolean, stored as 0 or 1, and holds 5/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("MySQL: a truth value is a boolean on every driver, whatever form it gives it in, and a BIGINT a BigInt; a TINYINT(1) holding 2 refused", async () => {
  const columns: Columns = [["done", "bool"], ["same", "bool"], ["one_bit", "bool"], ["n", "int8"], ["widened", "int8"], ["either", "int8|float|decimal"]];
  const fixtureQuery: QueryModule<"mysql"> = { columns, dialect: "mysql", params: [], sql: "select 1" };
  const expected = [{ done: true, either: 2.5, n: BigInt("9007199254740993"), one_bit: true, same: false, widened: BigInt("7") }];
  // Mysql2: a TINYINT(1) a number, a comparison a BIGINT's text (bigNumberStrings), a BIT(1) a Buffer, an INT a temporary table may widen a number.
  await checkMysql2Truth(fixtureQuery, expected);
  await checkOtherTruthDrivers(fixtureQuery, expected);

});
