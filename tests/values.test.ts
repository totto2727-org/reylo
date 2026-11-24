// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execute } from '../src/execute.ts';
import type { QueryModule } from '../src/execute.ts';
import { renderParamType, renderType } from "../src/render.ts";
import { typeSchema } from "../src/schema.ts";
import { coerce, columnKind, DecodeError, duration, hstore, hstoreText, instant, kindType, postgresInterval, postgresYear, scalarKind, textDecoder } from "../src/values.ts";
import type { EngineType } from "../src/engine-type.ts";
import type { Columns } from "../src/values.ts";
import { nativeDriverDate, promiseDriverStub } from "./helpers.ts";

// The one table (src/values.ts): the kind of each SQL type, the TypeScript type the module declares
// For it, the JSON Schema of its JSON form, and the value the run time gives it, which must agree.

const scalar = (name: string): EngineType => ({ kind: "scalar", name });
/** The TypeScript type a value is, as the declared type names it. */
const typeOf = function (v: unknown): string {
  if (v === null) {return "null";}
  // No value Reylo returns is one.
  if (v instanceof Date) {return "Date";}
  if (v instanceof Uint8Array) {return "Uint8Array";}
  if (Array.isArray(v)) {return `${typeOf(v.find((x) => x !== null))}[]`;}
  return typeof v;
};

// A Postgres value's text, as the server writes it, for every type whose kind is not its text.
const TEXTS: Record<string, string> = {
  bool: "t", int2: "2", int4: "4", oid: "26", float4: "1.1", float8: "2.2", int8: "9007199254740993", numeric: "1.100000000000000001",
  money: "$1.50", date: "2026-10-20", timestamp: "2026-10-20 10:00:00.123456", timestamptz: "2026-10-20 10:00:00.123456+02",
  time: "10:00:00", timetz: "10:00:00+02", interval: "1 day", json: '{"a":1}', jsonb: "[1,2]", bytea: "\\x0102ff", uuid: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  text: "hi", point: "(1,2)", int4range: "[1,5)", xid: "7", void: "",
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("every Postgres type's decoded value is the type the module declares for it, and its JSON form is its schema's", () => {
  Object.entries(TEXTS).forEach(([name, text]) => {
    const t = scalar(name);
    const kind = columnKind(t, "postgres");
    const value = textDecoder(kind)(text);
    const declared = renderType(t, false, "postgres");
    // A JSON value is any JSON, `Json`: what JSON.parse gives back.
    if (declared === "Json") {assert.deepEqual(JSON.parse(JSON.stringify(value)), value, name);}
    else if (declared !== "unknown") {assert.equal(typeOf(value), declared, name);}
    // The array of it, NULL elements null.
    const array: EngineType = { kind: "array", of: t };
    const values = textDecoder(columnKind(array, "postgres"))(`{${JSON.stringify(text)},NULL}`) as unknown[];
    assert.equal(values[1], null, name);
    if (declared === "Json") {assert.equal(renderType(array, false, "postgres"), "Json[]", name);}
    else if (declared !== "unknown") {assert.equal(`(${typeOf(values[0])} | null)[]`, renderType(array, false, "postgres"), name);}
    // The value written as JSON, a BigInt as the integer it is, has the schema's JSON type.
    const schema = typeSchema(t, "postgres") as { type?: string | string[] };
    if (schema.type !== undefined) {
      const written = JSON.stringify(value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value, (_, x) => (typeof x === "bigint" ? (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(String(x)) : x));
      assert.equal(written, typeof value === "bigint" ? String(value) : written, name);
      const json = JSON.parse(written);
      const jsonType = typeof json === "number" ? (Number.isInteger(json) ? ["integer", "number"] : ["number"]) : [typeof json];
      assert.ok([schema.type].flat().some((t) => jsonType.includes(t)), `${name}: ${JSON.stringify(json)} against ${JSON.stringify(schema)}`);
    }
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the representation, value by value", () => {
  const d = (name: string, text: string) => textDecoder(scalarKind(name, "postgres"))(text);
  assert.equal(d("int8", "9007199254740993"), BigInt("9007199254740993"));
  assert.equal(d("int8", "-9223372036854775808"), -BigInt("9223372036854775808"));
  assert.deepEqual(textDecoder(`${scalarKind("int8", "postgres")  }[]`)("{1,NULL,9223372036854775807}"), [BigInt("1"), null, BigInt("9223372036854775807")]);
  assert.equal(d("timestamptz", "2026-10-20 10:00:00.123456+02"), "2026-10-20T08:00:00.123456Z");
  assert.equal(d("numeric", "12345678901234567890.123456789"), "12345678901234567890.123456789");
  assert.equal(d("date", "2026-10-20"), "2026-10-20");
  assert.equal(d("timestamp", "2026-10-20 10:00:00.123456"), "2026-10-20T10:00:00.123456");
  assert.equal(d("timestamp", "0044-03-15 12:00:00 BC"), "-000043-03-15T12:00:00");
  assert.equal(d("timestamp", "infinity"), "infinity");
  assert.equal(d("interval", "1 year 2 mons"), "P1Y2M");
  assert.deepEqual(d("bytea", "\\x0102ff"), Buffer.from([1, 2, 255]));
  assert.deepEqual([...(d("bytea", "\\001\\\\x") as Uint8Array)], [1, 92, 120], "the escape format too");
  assert.deepEqual(d("jsonb", '{"big":9007199254740993}'), { big: 9_007_199_254_740_992 });
  assert.equal(d("bool", "f"), false);
  assert.ok(Number.isNaN(d("float8", "NaN") as number));
  assert.equal(d("float8", "-Infinity"), -Infinity);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("interval: an ISO 8601 duration with its sign in front, which Temporal reads, and each part signed where the parts' signs differ", () => {
  const Temporal = (globalThis as unknown as { Temporal: { Duration: { from(text: string): { toString(): string } } } }).Temporal;
  // Postgres's text in IntervalStyle postgres, Reylo's value, and Postgres's own in iso_8601, as Postgres 18 writes them.
  Iterator.from([
    ["1 mon", "P1M", "P1M"],
    ["1 year 2 mons 3 days 04:05:06.789", "P1Y2M3DT4H5M6.789S", "P1Y2M3DT4H5M6.789S"],
    ["00:00:00", "PT0S", "PT0S"],
    ["48:00:00", "PT48H", "PT48H"],
    ["00:00:00.000001", "PT0.000001S", "PT0.000001S"],
    ["-1 days", "-P1D", "P-1D"],
    ["-1 years -2 mons", "-P1Y2M", "P-1Y-2M"],
    ["-1 mons -2 days -00:00:03", "-P1M2DT3S", "P-1M-2DT-3S"],
    ["-178956970 years -7 mons -2147483647 days -2562047788:00:54.775807", "-P178956970Y7M2147483647DT2562047788H54.775807S", "P-178956970Y-7M-2147483647DT-2562047788H-54.775807S"],
  ] as [string, string, string][]).forEach(([text, iso, postgres]) => {
    assert.equal(duration(text), iso, text);
    assert.equal(Temporal.Duration.from(iso).toString(), iso, `${text}: Temporal reads it`);
    assert.equal(postgresInterval(iso), postgres, `${text}: as a parameter, in the form Postgres reads`);
  });
  // Parts of different signs have no ISO 8601 form: Postgres's own, which Temporal refuses.
  Iterator.from([
    ["1 mon -1 days", "P1M-1D"],
    ["-1 days +01:00:00", "P-1DT1H"],
    ["1 day -01:30:00.5", "P1DT-1H-30M-0.5S"],
  ] as [string, string][]).forEach(([text, iso]) => {
    assert.equal(duration(text), iso, text);
    assert.equal(postgresInterval(iso), iso, `${text}: already the form Postgres reads`);
  });
  assert.equal(duration("infinity"), "infinity");
  assert.equal(duration("-infinity"), "-infinity");
  // Any other text, such as a parameter in Postgres's own words, goes as it is.
  assert.equal(postgresInterval("-1 days"), "-1 days");
  assert.equal(postgresInterval("+P1D"), "P1D");
  assert.deepEqual(textDecoder("interval[]")('{"1 day",NULL,-00:00:03}'), ["P1D", null, "-PT3S"]);
  assert.equal(coerce("interval", "-1 days", "span"), "-P1D", "a driver's text, as Bun.sql gives it");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("date and timestamp: a year outside 0000 to 9999 in ISO 8601's extended form, as timestamptz's, which Temporal reads and a parameter takes back", () => {
  type PlainFrom = { from(text: string): { toString(): string } };
  const Temporal = (globalThis as unknown as { Temporal: { PlainDate: PlainFrom; PlainDateTime: PlainFrom } }).Temporal;
  const date = textDecoder("date");
  const timestamp = textDecoder("timestamp");
  Iterator.from([
    ["2026-10-20", "2026-10-20"],
    ["0001-01-01", "0001-01-01"],
    ["9999-12-31", "9999-12-31"],
    ["0001-12-31 BC", "0000-12-31"],
    ["0002-06-01 BC", "-000001-06-01"],
    ["4714-11-24 BC", "-004713-11-24"],
    ["10000-01-01", "+010000-01-01"],
    ["12345-01-01", "+012345-01-01"],
    ["275760-09-13", "+275760-09-13"],
  ] as const).forEach(([text, iso]) => {
    assert.equal(date(text), iso, text);
    assert.equal(Temporal.PlainDate.from(iso).toString(), iso, iso);
    // The round-trip rule: the parameter is the text the server wrote, which it reads as the same date.
    assert.equal(postgresYear(iso), text, iso);
  });
  Iterator.from([
    ["2026-10-20 10:00:00.123456", "2026-10-20T10:00:00.123456"],
    ["0001-12-31 23:59:59.999999 BC", "0000-12-31T23:59:59.999999"],
    ["0002-06-01 12:00:00 BC", "-000001-06-01T12:00:00"],
    ["4714-11-24 00:00:00 BC", "-004713-11-24T00:00:00"],
    ["10000-01-01 00:00:00", "+010000-01-01T00:00:00"],
    ["123456-01-01 00:00:00.5", "+123456-01-01T00:00:00.5"],
    ["275760-09-13 00:00:00", "+275760-09-13T00:00:00"],
  ] as const).forEach(([text, iso]) => {
    assert.equal(timestamp(text), iso, text);
    assert.equal(Temporal.PlainDateTime.from(iso).toString(), iso, iso);
    assert.equal(postgresYear(iso), text.replace(" ", "T"), iso);
  });
  // A date past 999999 AD, which only Postgres's date reaches (5874897), keeps a sign before the
  // Digits it needs; Temporal holds no such date, and the parameter still reads it back.
  assert.equal(date("5874897-12-31"), "+5874897-12-31");
  assert.equal(date("1000000-01-01"), "+1000000-01-01");
  assert.equal(postgresYear("+5874897-12-31"), "5874897-12-31");
  assert.throws(() => Temporal.PlainDate.from("+5874897-12-31"), RangeError);
  Iterator.from(["infinity", "-infinity"]).forEach((word) => {
    assert.equal(date(word), word);
    assert.equal(timestamp(word), word);
  });
  // Arrays: each element as a scalar's, a BC element quoted in Postgres's text.
  assert.deepEqual(textDecoder("date[]")('{"0002-06-01 BC",12345-01-01,2026-10-20,NULL,infinity}'), ["-000001-06-01", "+012345-01-01", "2026-10-20", null, "infinity"]);
  assert.deepEqual(textDecoder("timestamp[]")('{"0002-06-01 12:00:00 BC","10000-01-01 00:00:00",-infinity}'), ["-000001-06-01T12:00:00", "+010000-01-01T00:00:00", "-infinity"]);
  // A driver's Date (Bun.sql's, read as UTC) gives the same text as the server's.
  assert.equal(coerce("date", nativeDriverDate("+012345-01-01T00:00:00Z"), "d"), "+012345-01-01");
  assert.equal(coerce("timestamp", nativeDriverDate("+010000-01-01T00:00:00.250Z"), "t"), "+010000-01-01T00:00:00.25");
  assert.equal(coerce("timestamp", nativeDriverDate("-000001-06-01T12:00:00Z"), "t"), "-000001-06-01T12:00:00");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("timestamptz: the instant's ISO 8601 text in UTC, the server's fraction kept, which new Date(text) gets wrong for BC, year 1 and offsets with seconds", () => {
  const Temporal = (globalThis as unknown as { Temporal: { Instant: { from(text: string): { toString(): string; epochNanoseconds: bigint } } } }).Temporal;
  Iterator.from([
    ["2026-10-20 03:03:00.123456-07", "2026-10-20T10:03:00.123456Z"],
    ["2026-10-20 10:00:00+00", "2026-10-20T10:00:00Z"],
    ["2026-10-20 10:00:00.5+05:30", "2026-10-20T04:30:00.5Z"],
    ["2026-12-31 23:30:00-01", "2027-01-01T00:30:00Z"],
    ["0001-01-01 00:00:00+00", "0001-01-01T00:00:00Z"],
    ["0001-01-01 00:30:00+01", "0000-12-31T23:30:00Z"],
    ["1883-11-18 12:00:00-07:52:58", "1883-11-18T19:52:58Z"],
    ["1900-01-01 00:00:00+00:00:36", "1899-12-31T23:59:24Z"],
    ["0001-12-31 23:59:59.999999+00 BC", "0000-12-31T23:59:59.999999Z"],
    ["0002-06-01 12:00:00+00 BC", "-000001-06-01T12:00:00Z"],
    ["0044-03-15 12:00:00+00 BC", "-000043-03-15T12:00:00Z"],
    ["4713-11-24 00:00:00+00 BC", "-004712-11-24T00:00:00Z"],
    ["9999-12-31 23:59:59.999999-01", "+010000-01-01T00:59:59.999999Z"],
    ["12345-01-01 00:00:00+05:30", "+012344-12-31T18:30:00Z"],
    ["2000-02-29 12:00:00+00", "2000-02-29T12:00:00Z"],
    ["1900-03-01 00:00:00+01", "1900-02-28T23:00:00Z"],
  ] as const).forEach(([text, iso]) => {
    assert.equal(instant(text), iso, text);
    // Temporal reads each back to the same text: an ISO 8601 instant, the year extended outside 0000 to 9999.
    assert.equal(Temporal.Instant.from(iso).toString(), iso, iso);
  });
  // Each to the nanosecond against Temporal's own reading of the server's offset (its microseconds kept).
  assert.equal(Temporal.Instant.from(instant("2026-10-20 03:03:00.123456-07")).epochNanoseconds, Temporal.Instant.from("2026-10-20T03:03:00.123456-07:00").epochNanoseconds);
  // Past Temporal's range (±10^8 days), which Postgres's reaches (294276 AD): still ISO 8601 text.
  assert.equal(instant("294276-12-31 23:59:59.999999+00"), "+294276-12-31T23:59:59.999999Z");
  assert.throws(() => Temporal.Instant.from("+294276-12-31T23:59:59.999999Z"), RangeError);
  assert.equal(instant("infinity"), "infinity");
  assert.equal(instant("-infinity"), "-infinity");
  // The failing control: what postgres.js and PGlite use, and what a Date holds.
  assert.equal(nativeDriverDate("0001-01-01 00:00:00+00").getUTCFullYear(), 2001);
  assert.equal(nativeDriverDate("2026-10-20T03:03:00.123456-07:00").toISOString(), "2026-10-20T10:03:00.123Z");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: the kinds, and a NUMERIC column of either", () => {
  assert.deepEqual(["integer", "real", "text", "blob", "numeric", "bool", "mystery"].map((n) => scalarKind(n, "sqlite")), ["int", "float", "text", "bytes", "int|float|text", "bool", "unknown"]);
  assert.deepEqual(["int", "int|float|text", "unknown", "bytes"].map(kindType), ["number", "number | string", "unknown", "Uint8Array"]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a column declared BIGINT, INT8 or UNSIGNED BIG INT (the engine's int8) is a BigInt, as on Postgres and MySQL, and its parameter takes one back", () => {
  assert.equal(scalarKind("int8", "sqlite"), "int8");
  assert.equal(renderType(scalar("int8"), false, "sqlite"), "bigint");
  assert.equal(renderType(scalar("int8"), true, "sqlite"), "number", "inside a JSON document, the number SQLite writes");
  assert.equal(renderParamType(scalar("int8"), "sqlite"), "number | bigint");
  assert.deepEqual(typeSchema(scalar("int8"), "sqlite"), { format: "int64", type: "integer" }, "the BigInt, as the JSON integer it is");
  assert.deepEqual(typeSchema(scalar("int8"), "sqlite"), typeSchema(scalar("int8"), "postgres"));
  // Inside a document a non-finite float or decimal is the text Postgres writes; MySQL stores none.
  assert.deepEqual(typeSchema(scalar("float8"), "postgres", false, true), { anyOf: [{ format: "double", type: "number" }, { enum: ["NaN", "Infinity", "-Infinity"] }] });
  assert.deepEqual(typeSchema(scalar("numeric"), "mysql", false, true), { format: "decimal", type: "number" });
  assert.deepEqual(typeSchema(scalar("interval"), "postgres", false, true), { description: "pg type interval", type: "string" }, "inside a document, Postgres's own text");
  assert.deepEqual(typeSchema(scalar("int8"), "sqlite", true), { format: "int64", type: "integer" }, "a parameter");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a BIGINT column on node:sqlite exact past 2^53 beside an INTEGER read as a number, whatever the database's setting; on the drivers that round, a BigInt within 2^53 and a rounded value refused", async () => {
  Iterator.from([false, true]).forEach((readBigInts) => {
    const db = new DatabaseSync(":memory:", { readBigInts });
    db.exec("create table t (id integer primary key, n integer, big bigint); insert into t values (1, 5, 9007199254740993), (2, 6, -9007199254740993), (3, 7, null)");
    const q: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select id, n, big from t order by id", params: [], columns: [["id", "int"], ["n", "int"], ["big", "int8"]] };
    assert.deepEqual(execute(db, q), [{ id: 1, n: 5, big: BigInt("9007199254740993") }, { id: 2, n: 6, big: -BigInt("9007199254740993") }, { id: 3, n: 7, big: null }]);
    // The failing control: the app's own statement at the database's setting, which without
    // ReadBigInts refuses the value with an error that names no column.
    const own = () => ({ ...(db.prepare("select n, big from t where id = 1").get() as object) });
    if (readBigInts) {assert.deepEqual(own(), { n: BigInt("5"), big: BigInt("9007199254740993") });}
    else {assert.throws(own, /^RangeError: Value is too large to be represented as a JavaScript number: 9007199254740993/u);}
    db.close();
  });
  const q: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select n, big from t", params: [], columns: [["n", "int"], ["big", "int8"]] };
  const d1 = (results: unknown[]) => ({ batch: promiseDriverStub(() => []), prepare: () => ({ first: promiseDriverStub(() => null), bind: () => ({ all: promiseDriverStub(() => ({ results })) }) }) });
  assert.deepEqual(await execute(d1([{ n: 5, big: 9_007_199_254_740_991 }, { n: 6, big: -3 }]), q), [{ n: 5, big: BigInt("9007199254740991") }, { n: 6, big: -BigInt("3") }]);
  await assert.rejects(execute(d1([{ n: 5, big: 9_007_199_254_740_992 }]), q) as Promise<unknown>, (e: Error) => e instanceof DecodeError && /^Column "big" is a 64-bit integer, and the driver already rounded its value to 9007199254740992/u.test(e.message));
  // LibSQL under each intMode: a number, a BigInt or the digits.
  const libsql = (rows: unknown[]) => ({ execute: promiseDriverStub(() => ({ rows })), executeMultiple: async () => {} });
  for (const big of [7, BigInt("7"), "7"]) {assert.deepEqual(await execute(libsql([{ n: 5, big }]), q), [{ n: 5, big: BigInt("7") }], typeof big);}
  assert.deepEqual(await execute(libsql([{ n: 5, big: "9007199254740993" }]), q), [{ n: 5, big: BigInt("9007199254740993") }]);
  // Bun.sql's SQLite, with safeIntegers or without.
  const bun = (rows: unknown[]) => ({ unsafe: promiseDriverStub(() => rows), commitDistributed: async () => {} });
  assert.deepEqual(await execute(bun([{ n: 5, big: BigInt("9007199254740993") }]), q), [{ n: 5, big: BigInt("9007199254740993") }]);
  await assert.rejects(execute(bun([{ n: 5, big: 9_007_199_254_740_992 }]), q) as Promise<unknown>, /Column "big" is a 64-bit integer, and the driver already rounded/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("coerce: a value a driver decoded, given its kind; an integer a number cannot hold is refused, naming the column", () => {
  assert.equal(coerce("int8", BigInt("9007199254740993"), "c"), BigInt("9007199254740993"));
  assert.equal(coerce("int8", "9007199254740993", "c"), BigInt("9007199254740993"), "a driver's exact text");
  assert.equal(coerce("int8", 42, "c"), BigInt("42"));
  assert.throws(() => coerce("int8", 9_007_199_254_740_992, "big_id"), (e: Error) => e instanceof DecodeError && /^Column "big_id" is a 64-bit integer, and the driver already rounded its value to 9007199254740992/u.test(e.message));
  assert.deepEqual(coerce("int8[]", ["1", BigInt("2")], "c"), [BigInt("1"), BigInt("2")]);
  assert.equal(coerce("decimal", 1.5, "c"), "1.5");
  assert.equal(coerce("date", nativeDriverDate("2026-10-20T00:00:00Z"), "c"), "2026-10-20");
  // Bun.sql decodes a date or timestamp before 1 AD as an Invalid Date (its infinities are ±Infinity):
  // Refused, never read as infinity.
  Iterator.from(["date", "timestamp", "timestamptz", "timestamp|timestamptz"]).forEach((kind) => {
    assert.throws(() => coerce(kind, nativeDriverDate(Number.NaN), "born"), (e: Error) => e instanceof DecodeError && /^Column "born": the driver returned an Invalid Date/u.test(e.message), kind);
  });
  assert.equal(coerce("timestamptz", Infinity, "c"), "infinity");
  assert.equal(coerce("timestamptz", -Infinity, "c"), "-infinity");
  assert.equal(coerce("timestamp", nativeDriverDate("2026-10-20T10:00:00.500Z"), "c"), "2026-10-20T10:00:00.5");
  assert.equal(coerce("timestamptz", nativeDriverDate("2026-10-20T10:00:00.500Z"), "c"), "2026-10-20T10:00:00.5Z", "Bun.sql's Date, to its millisecond");
  assert.equal(coerce("timestamptz", nativeDriverDate("2026-10-20T10:00:00Z"), "c"), "2026-10-20T10:00:00Z");
  assert.equal(coerce("timestamptz", "2026-10-20 10:00:00.123456+02", "c"), "2026-10-20T08:00:00.123456Z");
  assert.equal(coerce("timestamptz", -Infinity, "c"), "-infinity");
  assert.deepEqual(coerce("int[]", Int32Array.of(1, 2), "c"), [1, 2]);
  assert.deepEqual(coerce("text[]", "{a,NULL}", "c"), ["a", null]);
  assert.equal(coerce("text", ["x", "z"], "c"), "x,z", "mariadb's SET");
  assert.deepEqual(coerce("bytes", true, "c"), Uint8Array.of(1), "Bun.sql's and mariadb's BIT(1) where it is no boolean (a view's)");
  assert.deepEqual(coerce("bytes", [1, 2], "c"), Uint8Array.of(1, 2), "D1's BLOB");
  assert.deepEqual(coerce("bytes", Uint8Array.of(3).buffer, "c"), Uint8Array.of(3), "libSQL's BLOB");
  assert.deepEqual(coerce("json", '{"a":1}', "c"), { a: 1 });
  assert.equal(coerce("int", BigInt("9007199254740991"), "c"), 9_007_199_254_740_991);
  // The bounds, exactly: ±(2^53 - 1) is a number, ±2^53 refused.
  assert.deepEqual([BigInt("9007199254740991"), -BigInt("9007199254740991"), BigInt("0")].map((v) => coerce("int", v, "n")), [9_007_199_254_740_991, -9_007_199_254_740_991, 0]);
  Iterator.from([BigInt("9007199254740992"), -BigInt("9007199254740992"), BigInt("2") ** BigInt("63") - BigInt("1"), -(BigInt("2") ** BigInt("63"))]).forEach((v) => {assert.throws(() => coerce("int", v, "n"), DecodeError, String(v));});
  assert.throws(() => coerce("int", BigInt("9007199254740993"), "big_id"), (e: Error) => e instanceof DecodeError && /^Column "big_id" holds 9007199254740993, an integer past ±\(2\^53 - 1\)/.test(e.message));
  assert.throws(() => coerce("int", 9_007_199_254_740_992, "big_id"), /Column "big_id" holds an integer past ±\(2\^53 - 1\), which the driver already rounded to 9007199254740992/);
  // A NUMERIC may hold a REAL past 2^53, which is no rounded integer.
  assert.equal(coerce("int|float|text", 1e20, "c"), 1e20);
  // A MySQL either: a BIGINT a BigInt, a DOUBLE a number, a DECIMAL its text.
  assert.equal(coerce("int8|float|decimal", BigInt("1"), "c"), BigInt("1"));
  assert.equal(coerce("int8|float|decimal", 2.5, "c"), 2.5);
  assert.equal(coerce("int8|float|decimal", "1.10", "c"), "1.10");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a truth value: 0 or 1 in every form a driver gives it, and any other value refused, naming the column", () => {
  Iterator.from([true, 1, BigInt("1"), "1", "t", "true", Uint8Array.of(1)]).forEach((v) => {assert.equal(coerce("bool", v, "c"), true, String(v));});
  Iterator.from([false, 0, BigInt("0"), "0", "f", "false", Uint8Array.of(0)]).forEach((v) => {assert.equal(coerce("bool", v, "c"), false, String(v));});
  // The failing control: a MySQL TINYINT(1) or a SQLite BOOLEAN holds any integer the database lets in.
  Iterator.from([[2, "2"], [-1, "-1"], [BigInt("255"), "255"], ["yes", '"yes"'], [0.5, "0.5"], [Uint8Array.of(2), "the bytes 0x02"]] as const).forEach(([v, shown]) => {
    assert.throws(() => coerce("bool", v, "active"), (e: Error) => e instanceof DecodeError && e.message.startsWith(`Column "active" is a boolean, stored as 0 or 1, and holds ${shown}, which is neither`), String(v));
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the kinds: a BIGINT is a BigInt, and an integer a temporary table may widen to one is too; a timestamptz a string; no kind a Date", () => {
  assert.deepEqual(["int8", "int8|int4", "int4|int8", "int8|float8|numeric", "int4|int8|float8|numeric", "bool", "timestamptz"].map((n) => scalarKind(n, "mysql")), ["int8", "int8", "int8", "int8|float|decimal", "int|int8|float|decimal", "bool", "timestamptz"]);
  assert.deepEqual(["int8", "int8|int4", "int8|float8|numeric", "bool", "timestamptz", "date"].map((n) => kindType(scalarKind(n, "mysql"))), ["bigint", "bigint", "bigint | number | string", "boolean", "string", "string"]);
  assert.equal(renderType({ kind: "array", of: scalar("int8") }), "(bigint | null)[]");
  assert.equal(renderType(scalar("int8"), true), "number", "inside a JSON document, as the database writes it");
  assert.deepEqual(typeSchema(scalar("int8"), "postgres"), { format: "int64", type: "integer" });
  assert.deepEqual(typeSchema(scalar("int8"), "postgres", true), { format: "int64", type: ["integer", "string"] }, "a parameter, as every driver binds it");
  assert.deepEqual(typeSchema(scalar("timestamptz"), "postgres"), { format: "date-time", type: "string" });
  assert.deepEqual(typeSchema(scalar("bool"), "mysql"), { type: "boolean" });
  assert.deepEqual(typeSchema(scalar("bool"), "sqlite"), { type: "boolean" });
  assert.deepEqual(typeSchema(scalar("integer"), "sqlite"), { format: "int64", type: "integer" });
  assert.deepEqual(typeSchema(scalar("numeric"), "sqlite"), { type: ["number", "string"] });
  Iterator.from(["bool", "int", "float", "int8", "decimal", "text", "date", "timestamp", "timestamptz", "json", "bytes", "unknown"]).forEach((kind) => {assert.notEqual(kindType(kind), "Date", kind);});
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: Reylo's own statement per database and text, with integers read as BigInts whatever the database's setting, and the app's statements unchanged", () => {
  const db = new DatabaseSync(":memory:", { readBigInts: true, returnArrays: true });
  db.exec("create table t (id integer primary key, n integer, r real, b blob, doc text, flag integer, x); insert into t values (1, 5, 1.5, x'0102', '{\"a\":1}', 1, 7), (2, 9007199254740993, null, null, null, 0, null), (3, 1, null, null, null, 2, null)");
  const q: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select id, n, r, b, doc, flag, x from t where id = :id", params: ["id"], columns: [["id", "int"], ["n", "int"], ["r", "float"], ["b", "bytes"], ["doc", "json"], ["flag", "bool"], ["x", "unknown"]] };
  const [row] = execute(db, q, { id: 1 }) as Record<string, unknown>[];
  // A plain object, as on every other driver: node:sqlite's own rows have a null prototype.
  assert.deepEqual(row, { id: 1, n: 5, r: 1.5, b: Uint8Array.of(1, 2), doc: { a: 1 }, flag: true, x: 7 });
  // The failing control: the app's own statement keeps its database's settings.
  assert.deepEqual(db.prepare("select n from t where id = 1").get(), [BigInt("5")]);
  assert.throws(() => execute(db, q, { id: 2 }), (e: Error) => e instanceof DecodeError && e instanceof TypeError && /^Column "n" holds 9007199254740993/u.test(e.message));
  // A boolean column holding 2, which SQLite lets in: refused, naming it.
  assert.throws(() => execute(db, q, { id: 3 }), /^TypeError: Column "flag" is a boolean, stored as 0 or 1, and holds 2/u);
  // A query defined by hand: integers exact, nothing else known.
  const [bare] = execute(db, { dialect: "sqlite", sql: "select n, doc from t where id = 1", params: [] }) as Record<string, unknown>[];
  assert.deepEqual(bare, { doc: '{"a":1}', n: 5 });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: the asynchronous drivers' rows normalized: libSQL's BigInt, string and ArrayBuffer, D1's array, a rounded integer refused", async () => {
  const q: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select n, b, doc from t", params: [], columns: [["n", "int"], ["b", "bytes"], ["doc", "json"]] };
  const libsql = (rows: unknown[]) => ({ execute: promiseDriverStub(() => ({ rows })), executeMultiple: async () => {} });
  assert.deepEqual(await execute(libsql([{ n: BigInt("5"), b: Uint8Array.of(1).buffer, doc: "[1]" }]), q), [{ n: 5, b: Uint8Array.of(1), doc: [1] }]);
  assert.deepEqual(await execute(libsql([{ n: "5", b: null, doc: null }]), q), [{ b: null, doc: null, n: 5 }], "intMode: string");
  const d1 = { batch: promiseDriverStub(() => []), prepare: () => ({ first: promiseDriverStub(() => null), bind: () => ({ all: promiseDriverStub(() => ({ results: [{ n: 9_007_199_254_740_992, b: [1, 2], doc: "{}" }] })) }) }) };
  await assert.rejects(execute(d1, q) as Promise<unknown>, /Column "n" holds an integer past .* already rounded/);
  const ok = { ...d1, prepare: () => ({ first: promiseDriverStub(() => null), bind: () => ({ all: promiseDriverStub(() => ({ results: [{ n: 1, b: [1, 2], doc: "{}" }] })) }) }) };
  assert.deepEqual(await execute(ok, q), [{ n: 1, b: Uint8Array.of(1, 2), doc: {} }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: a value its column's type does not allow, which a table that is not STRICT stores, refused naming the column; a NUMERIC's text, an untyped column's BLOB and an INTEGER column's REAL kept", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`create table loose (id integer primary key, n integer, r real, s text, b blob, big bigint, z numeric, x);
    insert into loose values (1, 1.5, 2, 'hi', x'01', 9007199254740993, 'abc', x'02'), (2, 'abc', null, null, null, null, null, null), (3, x'0102', null, null, null, null, null, null),
      (4, null, 'xyz', null, null, null, null, null), (5, null, null, x'0203', null, null, null, null), (6, null, null, null, 'plain', null, null, null), (7, null, null, null, 5, null, null, null),
      (8, null, null, null, null, 1.5, null, null), (9, null, null, null, null, 'x', null, null), (10, null, null, null, null, null, x'01', null)`);
  const q: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select n, r, s, b, big, z, x from loose where id = :id", params: ["id"], columns: [["n", "int"], ["r", "float"], ["s", "text"], ["b", "bytes"], ["big", "int8"], ["z", "int|float|text"], ["x", "unknown"]] };
  assert.deepEqual(execute(db, q, { id: 1 }), [{ n: 1.5, r: 2, s: "hi", b: Uint8Array.of(1), big: BigInt("9007199254740993"), z: "abc", x: Uint8Array.of(2) }]);
  const refusals: [number, RegExp][] = [
    [2, /^TypeError: Column "n" is typed number and holds the text "abc": outside a STRICT table SQLite stores a value of any type in any column.* Replace the value, or read what the column holds with cast\(n as text\)\.$/],
    [3, /^TypeError: Column "n" is typed number and holds a BLOB of 2 bytes/u],
    [4, /^TypeError: Column "r" is typed number and holds the text "xyz"/u],
    [5, /^TypeError: Column "s" is typed string and holds a BLOB of 2 bytes/u],
    [6, /^TypeError: Column "b" is typed Uint8Array and holds the text "plain"/u],
    [7, /^TypeError: Column "b" is typed Uint8Array and holds the number 5/u],
    [8, /^TypeError: Column "big" is typed bigint and holds the number 1.5: .* Replace the value, or read what the column holds with cast\(big as text\)\.$/],
    [9, /^TypeError: Column "big" is typed bigint and holds the text "x"/u],
    [10, /^TypeError: Column "z" is typed number \| string and holds a BLOB of 1 byte:/u],
  ];
  Iterator.from(refusals).forEach(([id, refused]) => {assert.throws(() => execute(db, q, { id }), (e: Error) => e instanceof DecodeError && refused.test(String(e)), `row ${id}`);});
  // The drivers that read integers as numbers or strings: libSQL's digits are its INTEGER, any other text in a number's column is refused, and so is D1's BLOB in a string's.
  const libsql = (rows: unknown[]) => ({ execute: promiseDriverStub(() => ({ rows })), executeMultiple: async () => {} });
  const ints: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select n, big, b from loose", params: [], columns: [["n", "int"], ["big", "int8"], ["b", "bytes"]] };
  assert.deepEqual(await execute(libsql([{ n: "5", big: "9007199254740993", b: null }]), ints), [{ n: 5, big: BigInt("9007199254740993"), b: null }], "intMode: string");
  await assert.rejects(execute(libsql([{ n: "abc", big: null, b: null }]), ints) as Promise<unknown>, /Column "n" is typed number and holds the text "abc"/u);
  await assert.rejects(execute(libsql([{ n: 5, big: 1.5, b: null }]), ints) as Promise<unknown>, /Column "big" is typed bigint and holds the number 1.5/);
  await assert.rejects(execute(libsql([{ n: Uint8Array.of(1).buffer, big: null, b: null }]), ints) as Promise<unknown>, /Column "n" is typed number and holds a BLOB of 1 byte/u);
  await assert.rejects(execute(libsql([{ n: null, big: null, b: "5" }]), ints) as Promise<unknown>, /Column "b" is typed Uint8Array and holds the text "5"/u);
  const d1 = { batch: promiseDriverStub(() => []), prepare: () => ({ first: promiseDriverStub(() => null), bind: () => ({ all: promiseDriverStub(() => ({ results: [{ s: [1, 2] }] })) }) }) };
  await assert.rejects(execute(d1, { dialect: "sqlite", sql: "select s from loose", params: [], columns: [["s", "text"]] }) as Promise<unknown>, /Column "s" is typed string and holds a BLOB of 2 bytes/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql2: per-query options and Reylo's typeCast, never decimalNumbers; a DECIMAL and JSON as their text, a date's dropped fraction and its T, TIME's digits", async () => {
  let sent: Record<string, any> = {};
  const field = (type: string, text: string | null) => ({ type, string: () => text, buffer: () => (text === null ? null : Buffer.from(text)) });
  const pool = {
    query: promiseDriverStub(() => [[], []]),
    // Mysql2 calls the typeCast once per value with the field and its own reading, and resolves to [rows, fields].
    execute: async (options: Record<string, any>) => {
      sent = options;
      const cast = options.typeCast as (f: unknown, next: () => unknown) => unknown;
      const row = {
        amount: cast(field("NEWDECIMAL", "1.100000000000000001"), () => 1.1),
        doc: cast(field("JSON", '{"big":9007199254740993}'), () => ({ big: "9007199254740993" })),
        at: cast(field("DATETIME", null), () => "2026-03-08 09:31:00"),
        at6: cast(field("DATETIME", null), () => "2026-03-08 09:31:00.123456"),
        latest: cast(field("DATETIME", null), () => "2026-03-08 09:31:00"),
        t: cast(field("TIME", null), () => "10:00:00.5"),
        geo: cast(field("GEOMETRY", "wkb"), () => ({ x: 1, y: 2 })),
        big: cast(field("LONGLONG", null), () => "9007199254740993"),
      };
      const fields = [["amount", 246, 18], ["doc", 245, 0], ["at", 12, 3], ["at6", 12, 6], ["latest", 12, 0], ["t", 11, 2], ["geo", 255, 0], ["big", 8, 0]].map(([name, columnType, decimals]) => ({ name, columnType, decimals }));
      return [[row], fields];
    },
  };
  const [row] = (await execute(pool as never, { dialect: "mysql", sql: "select 1", params: [] })) as Record<string, unknown>[];
  // A BIGINT's exact text a BigInt, by the result's own column type (LONGLONG).
  assert.deepEqual(row, { amount: "1.100000000000000001", doc: { big: 9_007_199_254_740_992 }, at: "2026-03-08T09:31:00.000", at6: "2026-03-08T09:31:00.123456", latest: "2026-03-08T09:31:00", t: "10:00:00.50", geo: Buffer.from("wkb"), big: BigInt("9007199254740993") });
  assert.equal("decimalNumbers" in sent, false, "a per-query decimalNumbers poisons mysql2's parser cache for every pool");
  assert.equal("jsonStrings" in sent, false);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mariadb: every option per query, metaAsArray off, a SET joined and a DATETIME's T; a GEOMETRY read as bytes only where a column may hold one", async () => {
  let sent: Record<string, any> = {};
  const meta = [{ name: () => "tags", type: "SET", isSet: () => true }, { name: () => "at", type: "DATETIME", isSet: () => false }, { name: () => "id", type: "INT", isSet: () => false }];
  const conn = { batch: promiseDriverStub(() => ({})), query: async (options: Record<string, any>) => ((sent = options), Object.assign([{ tags: ["x", "z"], at: "2026-03-08 09:31:00.000", id: 1 }], { meta })) };
  assert.deepEqual([...((await execute(conn as never, { dialect: "mysql", sql: "select 1", params: [] })) as unknown[])], [{ at: "2026-03-08T09:31:00.000", id: 1, tags: "x,z" }]);
  assert.equal(sent.metaAsArray, false);
  // A BIGINT mariadb's own BigInt, a DECIMAL its text, on mariadb 3 and mariadb 2 (supportBigInt, bigNumberStrings).
  assert.deepEqual([sent.bigIntAsNumber, sent.supportBigNumbers, sent.decimalAsNumber, sent.supportBigInt, sent.bigNumberStrings], [false, false, false, true, true]);
  assert.equal(sent.typeCast, undefined, "an app's typeCast is switched off");
  await execute(conn as never, { dialect: "mysql", sql: "select 1", params: [], columns: [["shape", "unknown"]] });
  assert.equal(typeof sent.typeCast, "function");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("PlanetScale: Reylo's cast per query, the driver's own default with a DATETIME's T, over the app's", async () => {
  let cast: (field: { type: string; charset?: number }, value: string | null) => unknown = () => null;
  const conn = { execute: async (_: string, __?: unknown, options?: { cast: typeof cast }) => ((cast = options!.cast), { rows: [], statement: "" }) };
  await execute(conn, { dialect: "mysql", sql: "select 1", params: [] });
  const bytes = (s: string) => String.fromCharCode(...Buffer.from(s, "utf8"));
  assert.deepEqual(
    [cast({ type: "INT64" }, "9007199254740993"), cast({ type: "DATETIME" }, "2026-03-08 09:31:00.000"), cast({ type: "DECIMAL" }, "1.10"), cast({ type: "JSON" }, bytes('{"é":1}')), cast({ type: "INT32" }, "7"), cast({ type: "FLOAT64" }, "2.2"), cast({ type: "VARBINARY", charset: 63 }, "\u0001ÿ"), cast({ type: "VARCHAR", charset: 255 }, bytes("é")), cast({ type: "INT64" }, null)],
    [BigInt("9007199254740993"), "2026-03-08T09:31:00.000", "1.10", { é: 1 }, 7, 2.2, Uint8Array.of(1, 255), "é", null],
  );
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mariadb's callback API, whose rows carry no meta, and mariadb 2, whose columns have no isSet(): the module's kinds join a SET and give a DATETIME its T", async () => {
  const conn = {
    batch: () => ({}),
    query: (_: unknown, __: unknown, done: (e: Error | null, rows?: unknown, meta?: unknown) => void) => (setImmediate(() => done(null, [{ tags: ["x", "z"], at: "2026-03-08 09:31:00.000", id: 1 }], [{ name: () => "tags", type: "SET" }])), { on() {} }),
  };
  const q: QueryModule<"mysql"> = { dialect: "mysql", sql: "select 1", params: [], columns: [["tags", "text"], ["at", "timestamp"], ["id", "int"]] };
  assert.deepEqual(await execute(conn as never, q), [{ at: "2026-03-08T09:31:00.000", id: 1, tags: "x,z" }]);
  // A query defined by hand: the callback's own meta.
  assert.deepEqual(await execute(conn as never, { ...q, columns: undefined }), [{ at: "2026-03-08 09:31:00.000", id: 1, tags: "x,z" }]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("runSync refuses a client whose prepared statement answers through a promise, which run awaits", async () => {
  const db = { prepare: () => ({ all: promiseDriverStub(() => [{ n: 1 }]) }) };
  const q: QueryModule<"sqlite"> = { dialect: "sqlite", sql: "select 1 as n", params: [], columns: [["n", "int"]] };
  assert.deepEqual(await execute(db as never, q), [{ n: 1 }]);
  const { executeSync } = await import("../src/execute.ts");
  assert.throws(() => executeSync(db as never, { ...q, sql: "select 2 as n" }), /answered with a promise/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("mysql2: Reylo's typeCast only where it is needed, since mysql2 calls it for every value: a JSON or unknown column, unknown columns, or the app's typeCast, decimalNumbers or jsonStrings", async () => {
  const sent: unknown[] = [];
  const pool = (connectionConfig: Record<string, unknown> | undefined) => ({ pool: connectionConfig && { config: { connectionConfig } }, query: promiseDriverStub(() => [[], []]), execute: async (options: { typeCast: unknown }) => (sent.push(typeof options.typeCast === "function" ? "cast" : options.typeCast), [[], []]) });
  const q = (columns?: [string, string][]): QueryModule<"mysql"> => ({ dialect: "mysql", sql: "select 1", params: [], ...(columns ? { columns } : {}) });
  await execute(pool({}) as never, q([["n", "int8"], ["amount", "decimal"], ["at", "timestamp"]]));
  await execute(pool({}) as never, q([["doc", "json"]]));
  await execute(pool({}) as never, q([["shape", "unknown"]]));
  await execute(pool({}) as never, q());
  await execute(pool({ decimalNumbers: true }) as never, q([["amount", "decimal"]]));
  await execute(pool({ jsonStrings: true }) as never, q([["n", "int"]]));
  await execute(pool({ typeCast: () => null }) as never, q([["n", "int"]]));
  await execute(pool(undefined) as never, q([["n", "int"]]));
  assert.deepEqual(sent, [true, "cast", "cast", "cast", "cast", "cast", "cast", "cast"]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("MySQL: a truth value is a boolean on every driver, whatever form it gives it in, and a BIGINT a BigInt; a TINYINT(1) holding 2 refused", async () => {
  const columns: Columns = [["done", "bool"], ["same", "bool"], ["one_bit", "bool"], ["n", "int8"], ["widened", "int8"], ["either", "int8|float|decimal"]];
  const q: QueryModule<"mysql"> = { dialect: "mysql", sql: "select 1", params: [], columns };
  const expected = [{ done: true, same: false, one_bit: true, n: BigInt("9007199254740993"), widened: BigInt("7"), either: 2.5 }];
  // Mysql2: a TINYINT(1) a number, a comparison a BIGINT's text (bigNumberStrings), a BIT(1) a Buffer, an INT a temporary table may widen a number.
  const mysql2Row = (done: unknown) => ({ done, same: "0", one_bit: Buffer.of(1), n: "9007199254740993", widened: 7, either: 2.5 });
  const fields = [["done", 1], ["same", 8], ["one_bit", 16], ["n", 8], ["widened", 3], ["either", 5]].map(([name, columnType]) => ({ name, columnType, decimals: 0 }));
  const mysql2 = (done: unknown) => ({ query: promiseDriverStub(() => [[], []]), execute: async () => [[mysql2Row(done)], fields] });
  assert.deepEqual(await execute(mysql2(1) as never, q), expected);
  await assert.rejects(execute(mysql2(2) as never, q) as Promise<unknown>, /^TypeError: Column "done" is a boolean, stored as 0 or 1, and holds 2, which is neither/u);
  // A query defined by hand: a BIGINT by the result's own type, a TINYINT(1) as it is.
  assert.deepEqual(await execute(mysql2(2) as never, { ...q, columns: undefined }), [{ ...mysql2Row(2), same: BigInt("0"), n: BigInt("9007199254740993") }]);
  // Mariadb: a BIGINT its own BigInt, a BIT(1) a Buffer (bitOneIsBoolean off).
  const mariadb = (done: unknown) => ({ batch: promiseDriverStub(() => ({})), query: async () => [{ done, same: BigInt("0"), one_bit: Buffer.of(1), n: BigInt("9007199254740993"), widened: 7, either: 2.5 }] });
  assert.deepEqual([...((await execute(mariadb(1) as never, q)) as unknown[])], expected);
  await assert.rejects(execute(mariadb(-1) as never, q) as Promise<unknown>, /Column "done" is a boolean, stored as 0 or 1, and holds -1/u);
  // PlanetScale: Reylo's cast, then the kinds.
  const planetscale = (done: string) => ({
    execute: async (_: string, __: unknown, options: { cast: (f: { type: string; charset?: number }, v: string | null) => unknown }) => ({
      statement: "",
      rows: [{ done: options.cast({ type: "INT8" }, done), same: options.cast({ type: "INT64" }, "0"), one_bit: options.cast({ type: "BIT", charset: 63 }, "\u0001"), n: options.cast({ type: "INT64" }, "9007199254740993"), widened: options.cast({ type: "INT32" }, "7"), either: options.cast({ type: "FLOAT64" }, "2.5") }],
    }),
  });
  assert.deepEqual(await execute(planetscale("1") as never, q), expected);
  await assert.rejects(execute(planetscale("2") as never, q) as Promise<unknown>, /Column "done" is a boolean/u);
  // Bun.sql: a BIT(1) a boolean, a BIGINT its digits.
  const bun = (done: unknown) => ({ unsafe: promiseDriverStub(() => [{ done, same: "0", one_bit: true, n: "9007199254740993", widened: 7, either: 2.5 }]), commitDistributed: async () => {} });
  assert.deepEqual(await execute(bun(1) as never, q), expected);
  await assert.rejects(execute(bun(5) as never, q) as Promise<unknown>, /Column "done" is a boolean, stored as 0 or 1, and holds 5/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("MySQL: a VECTOR is an array of its floats on every driver that reads one, and its parameter binds their text", async () => {
  const vector: EngineType = { kind: "array", of: scalar("float4"), nullable_items: false };
  assert.equal(columnKind(vector, "mysql"), "float[]");
  assert.equal(renderType(vector), "number[]");
  assert.equal(renderParamType(vector, "mysql"), "number[]");
  // The server sends a VECTOR as its floats' bytes, 32-bit and little-endian (MySQL 9.7.2).
  const floats = [1, 2.5, -3, 0.10000000149011612];
  const bytes = Buffer.alloc(16);
  floats.forEach((f, i) => bytes.writeFloatLE(f, i * 4));
  const columns: Columns = [["v", "float[]"], ["vn", "float[]"]];
  const q: QueryModule<"mysql"> = { dialect: "mysql", sql: "select 1", params: [], columns };
  const expected = [{ v: floats, vn: null }];
  // Mysql2 3.x decodes the floats itself; mariadb and PlanetScale give the bytes.
  const fields = [{ name: "v", columnType: 242, decimals: 0 }, { name: "vn", columnType: 242, decimals: 0 }];
  assert.deepEqual(await execute({ query: promiseDriverStub(() => [[], []]), execute: promiseDriverStub(() => [[{ v: floats, vn: null }], fields]) } as never, q), expected);
  assert.deepEqual(await execute({ query: promiseDriverStub(() => [[], []]), execute: async () => [[{ v: Buffer.from(bytes), vn: null }], fields] } as never, q), expected);
  assert.deepEqual([...((await execute({ batch: promiseDriverStub(() => ({})), query: async () => [{ v: Buffer.from(bytes), vn: null }] } as never, q)) as unknown[])], expected);
  const planetscale = {
    execute: async (_: string, __: unknown, options: { cast: (f: { type: string; charset?: number }, v: string | null) => unknown }) => ({
      rows: [{ v: options.cast({ type: "VECTOR", charset: 63 }, String.fromCharCode(...bytes)), vn: options.cast({ type: "VECTOR", charset: 63 }, null) }],
    }),
  };
  assert.deepEqual(await execute(planetscale as never, q), expected);
  // A slice of a larger buffer, as a driver's row may be, reads from its own offset.
  assert.deepEqual(coerce("float[]", Buffer.concat([Buffer.of(9, 9, 9), bytes]).subarray(3), "v"), floats);
  assert.throws(() => coerce("float[]", bytes.subarray(0, 5), "v"), (e: Error) => e instanceof DecodeError && /Column "v" is a VECTOR, whose value is 4 bytes per 32-bit float, and holds 5 bytes/u.test(e.message));
  // A Postgres float4[] from Bun.sql is a Float32Array, which is not read as bytes.
  assert.deepEqual(coerce("float[]", new Float32Array([1, 2.5]), "v"), [1, 2.5]);

  // A parameter binds the text of its floats, which the engine's `to_vector(?)` reads, on every driver.
  const w: QueryModule<"mysql"> = { dialect: "mysql", sql: "insert into items (v) values (to_vector(:v))", params: ["v"], inputs: { v: { type: vector } } };
  const seen: unknown[][] = [];
  await execute({ query: promiseDriverStub(() => [[], []] as [unknown, unknown]), execute: async (_: unknown, v?: unknown[]) => (seen.push(v!), [[], []] as [unknown, unknown]) } as never, w, { v: floats });
  await execute({ query: async (_: string, v: unknown) => (seen.push(v as unknown[]), []), batch: promiseDriverStub(() => []) } as never, w, { v: floats });
  await execute({ unsafe: async (_: string, v?: unknown[]) => (seen.push(v!), []), commitDistributed: async () => {} } as never, w, { v: floats });
  await execute({ execute: async (_: string, v: unknown[]) => (seen.push(v), { rows: [] }) } as never, w, { v: floats });
  await execute({ batch: promiseDriverStub(() => ({})), query: async (_: string, v: unknown) => (seen.push(v as unknown[]), []) } as never, w, { v: null });
  assert.deepEqual(seen, [...Array(4).fill(["[1,2.5,-3,0.10000000149011612]"]), [null]]);
  const fake = { query: promiseDriverStub(() => [[], []]), execute: promiseDriverStub(() => [[], []]) } as never;
  await assert.rejects(execute(fake, w, { v: [1, "2"] }) as Promise<unknown>, /^TypeError: Parameter "v" is a VECTOR, an array of finite numbers, and the element at \[1\] is "2"\.$/u);
  await assert.rejects(execute(fake, w, { v: [1, NaN] }) as Promise<unknown>, /the element at \[1\] is NaN/u);
  await assert.rejects(execute(fake, w, { v: [Infinity] }) as Promise<unknown>, /the element at \[0\] is Infinity/u);
  await assert.rejects(execute(fake, w, { v: [1, null] }) as Promise<unknown>, /^TypeError: Parameter "v" is an array whose elements may not be null, and the element at \[1\] is/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an hstore's text is an object of its keys, and an object goes back in as that text", () => {
  // As Postgres 17 writes hstore(array['a','q"uote','back\\slash','b c','x=>y','',','], array['1','v"','\\','sp ace',null,'empty','comma,']).
  const text = String.raw`""=>"empty", ","=>"comma,", "a"=>"1", "b c"=>"sp ace", "x=>y"=>NULL, "q\"uote"=>"v\"", "back\\slash"=>"\\"`;
  const value = { "": "empty", ",": "comma,", a: "1", "b c": "sp ace", "x=>y": null, 'q"uote': 'v"', "back\\slash": "\\" };
  assert.deepEqual(hstore(text), value);
  assert.deepEqual(textDecoder("hstore")(text), value);
  assert.deepEqual(hstore(""), {});
  // A key named __proto__ is a key, not the object's prototype.
  assert.deepEqual(Object.keys(hstore(String.raw`"__proto__"=>"x"`)), ["__proto__"]);
  // An array of hstores, as Postgres quotes each element.
  assert.deepEqual(textDecoder("hstore[]")(String.raw`{"\"a\"=>\"1\"","\"k\"=>NULL",NULL}`), [{ a: "1" }, { k: null }, null]);
  // Bun.sql hands the text over; an object a driver parsed stays as it is.
  assert.deepEqual(coerce("hstore", String.raw`"a"=>"1"`, "h"), { a: "1" });
  assert.deepEqual(coerce("hstore", { a: "1" }, "h"), { a: "1" });
  const fail = (message: string): never => {
    throw new TypeError(message);
  };
  assert.equal(hstoreText(value, fail), String.raw`""=>"empty", ","=>"comma,", "a"=>"1", "b c"=>"sp ace", "x=>y"=>NULL, "q\"uote"=>"v\"", "back\\slash"=>"\\"`);
  assert.deepEqual(hstore(hstoreText(value, fail)), value);
  assert.equal(hstoreText({ a: undefined, b: "2" }, fail), String.raw`"b"=>"2"`);
  assert.throws(() => hstoreText({ n: 1 }, fail), /its key "n" holds 1/u);
  assert.throws(() => hstoreText(["a"], fail), /an object of its keys whose values are strings or null; got an array/u);
  // Only a plain object's keys are an hstore's: a Map or a class instance is refused, not written empty.
  assert.throws(() => hstoreText(new Map([["a", "1"]]), fail), /got a Map\./u);
  assert.throws(() => hstoreText(new (class Prefs {})(), fail), /got a Prefs\./u);
  assert.equal(hstoreText(Object.assign(Object.create(null), { a: "1" }), fail), String.raw`"a"=>"1"`);
});
