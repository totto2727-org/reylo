// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Compare native decoder and driver results with the test runner's assertions.
import assert from "node:assert/strict";
import { renderType } from "#reylo-source/render.ts";
import { typeSchema } from "#reylo-source/schema.ts";
import { coerce, columnKind, DecodeError, hstore, hstoreText, kindType, scalarKind, textDecoder } from "#reylo-source/values.ts";
import type { EngineType } from "#reylo-source/engine-type.ts";
import { nativeDriverDate, SQL_NULL } from "./helpers.ts";
import { driverRows, driverRow, scalarFixture } from "./driver-fixtures.ts";
import { hasFunctionType, isRecord, matchesBigInt, matchesNull, matchesNumber, matchesString, matchesUndefined } from "#reylo-source/native-predicates.ts";

// The one table (src/values.ts): the kind of each SQL type, the TypeScript type the module declares
// For it, the JSON Schema of its JSON form, and the value the run time gives it, which must agree.

// The TypeScript type the module declares for the decoded value.
const typeOf = function (value: unknown): string {
  if (matchesNull(value)) {return "null";}
  // No value Reylo returns is one.
  if (value instanceof Date) {return "Date";}
  if (value instanceof Uint8Array) {return "Uint8Array";}
  if (Array.isArray(value)) {return `${typeOf(value.find((element) => !matchesNull(element)))}[]`;}
  return typeof value;
};

// A Postgres value's text, as the server writes it, for every type whose kind is not its text.
const TEXTS: Record<string, string> = {
  bool: "t",
  bytea: String.raw`\x0102ff`,
  date: "2026-10-20",
  float4: "1.1",
  float8: "2.2",
  int2: "2",
  int4: "4",
  int4range: "[1,5)",
  int8: "9007199254740993",
  interval: "1 day",
  json: '{"a":1}',
  jsonb: "[1,2]",
  money: "$1.50",
  numeric: "1.100000000000000001",
  oid: "26",
  point: "(1,2)",
  text: "hi",
  time: "10:00:00",
  timestamp: "2026-10-20 10:00:00.123456",
  timestamptz: "2026-10-20 10:00:00.123456+02",
  timetz: "10:00:00+02",
  uuid: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  void: "",
  xid: "7",
};

const checkScalar = function (value: unknown, declared: string, name: string): void {
  // Exercise JSON serialization for a value the declaration exposes as Json.
  if (declared === "Json") {
    const serialized = JSON.stringify(value);
    const decoded: unknown = JSON.parse(serialized);
    assert.deepEqual(decoded, value, name);
  } else if (declared !== "unknown") {
    assert.equal(typeOf(value), declared, name);
  }
};

const checkArray = function (type: EngineType, text: string, declared: string): void {
  const array: EngineType = { kind: "array", of: type };
  const decode = textDecoder(columnKind(array, "postgres"));
  const values = driverRows(decode(`{${JSON.stringify(text)},NULL}`));
  assert.equal(values[1], SQL_NULL);
  if (declared === "Json") {assert.equal(renderType(array, false, "postgres"), "Json[]");}
  else if (declared !== "unknown") {assert.equal(`(${typeOf(values[0])} | null)[]`, renderType(array, false, "postgres"));}
};

const jsonTypes = (value: unknown): string[] => {
  if (!matchesNumber(value)) {return [typeof value];}
  return Number.isInteger(value) ? ["integer", "number"] : ["number"];
};

const jsonTypeMatches = (types: unknown, expected: string[]): boolean => {
  if (matchesString(types)) {return expected.includes(types);}
  assert.ok(Array.isArray(types));
  return types.some((type) => matchesString(type) && expected.includes(type));
};

const jsonInteger = (value: bigint): unknown => {
  const { rawJSON } = driverRow(JSON);
  assert.ok(hasFunctionType(rawJSON), "The native test host must serialize an exact JSON integer");
  return Reflect.apply(rawJSON, JSON, [String(value)]);
};

const checkJsonSchema = function (type: EngineType, value: unknown, name: string): void {
  const schema = typeSchema(type, "postgres");
  if (!isRecord(schema) || matchesUndefined(schema.type)) {return;}
  const input = value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value;
  const written = JSON.stringify(input, (_key, member: unknown) => matchesBigInt(member) ? jsonInteger(member) : member);
  assert.equal(written, matchesBigInt(value) ? String(value) : written, name);
  const json: unknown = JSON.parse(written);
  assert.ok(jsonTypeMatches(schema.type, jsonTypes(json)), `${name}: ${JSON.stringify(json)} against ${JSON.stringify(schema)}`);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("every Postgres type's decoded value is the type the module declares for it, and its JSON form is its schema's", () => {
  Object.entries(TEXTS).forEach(([name, text]) => {
    const type = scalarFixture(name);
    const kind = columnKind(type, "postgres");
    const value = textDecoder(kind)(text);
    const declared = renderType(type, false, "postgres");
    checkScalar(value, declared, name);
    checkArray(type, text, declared);
    checkJsonSchema(type, value, name);
  });
});

const decode = (name: string, text: string): unknown => textDecoder(scalarKind(name, "postgres"))(text);

const checkTextValues = function (): void {
  assert.equal(decode("int8", "9007199254740993"), BigInt("9007199254740993"));
  assert.equal(decode("int8", "-9223372036854775808"), -BigInt("9223372036854775808"));
  assert.deepEqual(textDecoder(`${scalarKind("int8", "postgres")  }[]`)("{1,NULL,9223372036854775807}"), [BigInt("1"), SQL_NULL, BigInt("9223372036854775807")]);
  assert.equal(decode("timestamptz", "2026-10-20 10:00:00.123456+02"), "2026-10-20T08:00:00.123456Z");
  assert.equal(decode("numeric", "12345678901234567890.123456789"), "12345678901234567890.123456789");
  assert.equal(decode("date", "2026-10-20"), "2026-10-20");
  assert.equal(decode("timestamp", "2026-10-20 10:00:00.123456"), "2026-10-20T10:00:00.123456");
  assert.equal(decode("timestamp", "0044-03-15 12:00:00 BC"), "-000043-03-15T12:00:00");
  assert.equal(decode("timestamp", "infinity"), "infinity");
  assert.equal(decode("interval", "1 year 2 mons"), "P1Y2M");
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the representation, value by value", () => {
  checkTextValues();
  assert.deepEqual(decode("bytea", String.raw`\x0102ff`), Buffer.from([1, 2, 255]));
  const escaped = decode("bytea", String.raw`\001\\x`);
  assert.ok(escaped instanceof Uint8Array);
  assert.deepEqual([...escaped], [1, 92, 120], "the escape format too");
  assert.deepEqual(decode("jsonb", '{"big":9007199254740993}'), { big: 9_007_199_254_740_992 });
  assert.equal(decode("bool", "f"), false);
  assert.ok(Number.isNaN(decode("float8", "NaN")));
  assert.equal(decode("float8", "-Infinity"), -Infinity);
});

const checkDriverDates = function (): void {
  // Bun.sql decodes a date or timestamp before 1 AD as an Invalid Date (its infinities are ±Infinity):
  // Refused, never read as infinity.
  Iterator.from(["date", "timestamp", "timestamptz", "timestamp|timestamptz"]).forEach((kind) => {
    assert.throws(() => coerce(kind, nativeDriverDate(Number.NaN), "born"), (candidate: unknown) => candidate instanceof DecodeError && candidate.message.startsWith('Column "born": the driver returned an Invalid Date'), kind);
  });
  assert.equal(coerce("timestamptz", Infinity, "c"), "infinity");
  assert.equal(coerce("timestamptz", -Infinity, "c"), "-infinity");
  assert.equal(coerce("timestamp", nativeDriverDate("2026-10-20T10:00:00.500Z"), "c"), "2026-10-20T10:00:00.5");
  assert.equal(coerce("timestamptz", nativeDriverDate("2026-10-20T10:00:00.500Z"), "c"), "2026-10-20T10:00:00.5Z", "Bun.sql's Date, to its millisecond");
  assert.equal(coerce("timestamptz", nativeDriverDate("2026-10-20T10:00:00Z"), "c"), "2026-10-20T10:00:00Z");
  assert.equal(coerce("timestamptz", "2026-10-20 10:00:00.123456+02", "c"), "2026-10-20T08:00:00.123456Z");
  assert.equal(coerce("timestamptz", -Infinity, "c"), "-infinity");
};

const checkIntegerBounds = function (): void {
  // The bounds, exactly: ±(2^53 - 1) is a number, ±2^53 refused.
  assert.deepEqual([BigInt("9007199254740991"), -BigInt("9007199254740991"), BigInt("0")].map((input) => coerce("int", input, "n")), [9_007_199_254_740_991, -9_007_199_254_740_991, 0]);
  Iterator.from([BigInt("9007199254740992"), -BigInt("9007199254740992"), BigInt("2") ** BigInt("63") - BigInt("1"), -(BigInt("2") ** BigInt("63"))]).forEach((input) => {assert.throws(() => coerce("int", input, "n"), DecodeError, String(input));});
  assert.throws(() => coerce("int", BigInt("9007199254740993"), "big_id"), (candidate: unknown) => candidate instanceof DecodeError && candidate.message.startsWith('Column "big_id" holds 9007199254740993, an integer past ±(2^53 - 1)'));
  assert.throws(() => coerce("int", 9_007_199_254_740_992, "big_id"), /Column "big_id" holds an integer past ±\(2\^53 - 1\), which the driver already rounded to 9007199254740992/u);
};

const checkBigIntValues = function (): void {
  assert.equal(coerce("int8", BigInt("9007199254740993"), "c"), BigInt("9007199254740993"));
  assert.equal(coerce("int8", "9007199254740993", "c"), BigInt("9007199254740993"), "a driver's exact text");
  assert.equal(coerce("int8", 42, "c"), BigInt("42"));
  assert.throws(() => coerce("int8", 9_007_199_254_740_992, "big_id"), (candidate: unknown) => candidate instanceof DecodeError && candidate.message.startsWith('Column "big_id" is a 64-bit integer, and the driver already rounded its value to 9007199254740992'));
  assert.deepEqual(coerce("int8[]", ["1", BigInt("2")], "c"), [BigInt("1"), BigInt("2")]);
  assert.equal(coerce("decimal", 1.5, "c"), "1.5");
  assert.equal(coerce("date", nativeDriverDate("2026-10-20T00:00:00Z"), "c"), "2026-10-20");
};

const checkBinaryCoercion = function (): void {
  assert.deepEqual(coerce("bytes", true, "c"), Uint8Array.of(1), "Bun.sql's and mariadb's BIT(1) where it is no boolean (a view's)");
  assert.deepEqual(coerce("bytes", [1, 2], "c"), Uint8Array.of(1, 2), "D1's BLOB");
  assert.deepEqual(coerce("bytes", Uint8Array.of(3).buffer, "c"), Uint8Array.of(3), "libSQL's BLOB");
};

const checkNumericKinds = function (): void {
  // A NUMERIC may hold a REAL past 2^53, which is no rounded integer.
  assert.equal(coerce("int|float|text", 1e20, "c"), 1e20);
  // A MySQL either: a BIGINT a BigInt, a DOUBLE a number, a DECIMAL its text.
  assert.equal(coerce("int8|float|decimal", BigInt("1"), "c"), BigInt("1"));
  assert.equal(coerce("int8|float|decimal", 2.5, "c"), 2.5);
  assert.equal(coerce("int8|float|decimal", "1.10", "c"), "1.10");
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("coerce: a value a driver decoded, given its kind; an integer a number cannot hold is refused, naming the column", () => {
  checkBigIntValues();
  checkDriverDates();
  assert.deepEqual(coerce("int[]", Int32Array.of(1, 2), "c"), [1, 2]);
  assert.deepEqual(coerce("text[]", "{a,NULL}", "c"), ["a", SQL_NULL]);
  assert.equal(coerce("text", ["x", "z"], "c"), "x,z", "mariadb's SET");
  checkBinaryCoercion();
  assert.deepEqual(coerce("json", '{"a":1}', "c"), { a: 1 });
  assert.equal(coerce("int", BigInt("9007199254740991"), "c"), 9_007_199_254_740_991);
  checkIntegerBounds();
  checkNumericKinds();
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a truth value: 0 or 1 in every form a driver gives it, and any other value refused, naming the column", () => {
  Iterator.from([true, 1, BigInt("1"), "1", "t", "true", Uint8Array.of(1)]).forEach((input) => {assert.equal(coerce("bool", input, "c"), true, String(input));});
  Iterator.from([false, 0, BigInt("0"), "0", "f", "false", Uint8Array.of(0)]).forEach((input) => {assert.equal(coerce("bool", input, "c"), false, String(input));});
  // The failing control: a MySQL TINYINT(1) or a SQLite BOOLEAN holds any integer the database lets in.
  Iterator.from([[2, "2"], [-1, "-1"], [BigInt("255"), "255"], ["yes", '"yes"'], [0.5, "0.5"], [Uint8Array.of(2), "the bytes 0x02"]] as const).forEach(([input, shown]) => {
    assert.throws(() => coerce("bool", input, "active"), (candidate: unknown) => candidate instanceof DecodeError && candidate.message.startsWith(`Column "active" is a boolean, stored as 0 or 1, and holds ${shown}, which is neither`), String(input));
  });
});

const checkScalarSchemas = function (): void {
  assert.deepEqual(typeSchema(scalarFixture("int8"), "postgres"), { format: "int64", type: "integer" });
  assert.deepEqual(typeSchema(scalarFixture("int8"), "postgres", true), { format: "int64", type: ["integer", "string"] }, "a parameter, as every driver binds it");
  assert.deepEqual(typeSchema(scalarFixture("timestamptz"), "postgres"), { format: "date-time", type: "string" });
  assert.deepEqual(typeSchema(scalarFixture("bool"), "mysql"), { type: "boolean" });
  assert.deepEqual(typeSchema(scalarFixture("bool"), "sqlite"), { type: "boolean" });
  assert.deepEqual(typeSchema(scalarFixture("integer"), "sqlite"), { format: "int64", type: "integer" });
  assert.deepEqual(typeSchema(scalarFixture("numeric"), "sqlite"), { type: ["number", "string"] });
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the kinds: a BIGINT is a BigInt, and an integer a temporary table may widen to one is too; a timestamptz a string; no kind a Date", () => {
  assert.deepEqual(["int8", "int8|int4", "int4|int8", "int8|float8|numeric", "int4|int8|float8|numeric", "bool", "timestamptz"].map((name) => scalarKind(name, "mysql")), ["int8", "int8", "int8", "int8|float|decimal", "int|int8|float|decimal", "bool", "timestamptz"]);
  assert.deepEqual(["int8", "int8|int4", "int8|float8|numeric", "bool", "timestamptz", "date"].map((name) => kindType(scalarKind(name, "mysql"))), ["bigint", "bigint", "bigint | number | string", "boolean", "string", "string"]);
  assert.equal(renderType({ kind: "array", of: scalarFixture("int8") }), "(bigint | null)[]");
  assert.equal(renderType(scalarFixture("int8"), true), "number", "inside a JSON document, as the database writes it");
  checkScalarSchemas();
  Iterator.from(["bool", "int", "float", "int8", "decimal", "text", "date", "timestamp", "timestamptz", "json", "bytes", "unknown"]).forEach((kind) => {assert.notEqual(kindType(kind), "Date", kind);});
});

const invalidHstore = (message: string): never => {
  // oxlint-disable-next-line rules/require-tagged-error -- The hstore writer must relay the caller's native TypeError.
  throw new TypeError(message);
};

const checkHstoreInputKinds = function (): void {
  // Only a plain object's keys are an hstore's: a Map or a class instance is refused, not written empty.
  assert.throws(() => hstoreText(new Map([["a", "1"]]), invalidHstore), /got a Map\./u);
  const Prefs = class Prefs { public value = "a"; };
  assert.throws(() => hstoreText(new Prefs(), invalidHstore), /got a Prefs\./u);
  const seed: unknown = Object.create(SQL_NULL);
  const inherited = Object.assign(driverRow(seed), { a: "1" });
  assert.equal(hstoreText(inherited, invalidHstore), `"a"=>"1"`);
};

const checkHstoreSerialization = function (value: Record<string, string | null>): void {
  assert.equal(hstoreText(value, invalidHstore), String.raw`""=>"empty", ","=>"comma,", "a"=>"1", "b c"=>"sp ace", "x=>y"=>NULL, "q\"uote"=>"v\"", "back\\slash"=>"\\"`);
  assert.deepEqual(hstore(hstoreText(value, invalidHstore)), value);
  assert.equal(hstoreText({ a: undefined, b: "2" }, invalidHstore), String.raw`"b"=>"2"`);
  assert.throws(() => hstoreText({ n: 1 }, invalidHstore), /its key "n" holds 1/u);
  assert.throws(() => hstoreText(["a"], invalidHstore), /an object of its keys whose values are strings or null; got an array/u);
  checkHstoreInputKinds();
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an hstore's text is an object of its keys, and an object goes back in as that text", () => {
  // As Postgres 17 writes hstore(array['a','q"uote','back\\slash','b c','x=>y','',','], array['1','v"','\\','sp ace',null,'empty','comma,']).
  const text = String.raw`""=>"empty", ","=>"comma,", "a"=>"1", "b c"=>"sp ace", "x=>y"=>NULL, "q\"uote"=>"v\"", "back\\slash"=>"\\"`;
  const value = Object.fromEntries([
    ["", "empty"], [",", "comma,"], ["a", "1"], ["b c", "sp ace"],
    ["x=>y", SQL_NULL], ['q"uote', 'v"'], [String.raw`back\slash`, "\\"],
  ]);
  assert.deepEqual(hstore(text), value);
  assert.deepEqual(textDecoder("hstore")(text), value);
  assert.deepEqual(hstore(""), {});
  // A key named __proto__ is a key, not the object's prototype.
  assert.deepEqual(Object.keys(hstore(String.raw`"__proto__"=>"x"`)), ["__proto__"]);
  // An array of hstores, as Postgres quotes each element.
  assert.deepEqual(textDecoder("hstore[]")(String.raw`{"\"a\"=>\"1\"","\"k\"=>NULL",NULL}`), [{ a: "1" }, { k: SQL_NULL }, SQL_NULL]);
  // Bun.sql hands the text over; an object a driver parsed stays as it is.
  assert.deepEqual(coerce("hstore", String.raw`"a"=>"1"`, "h"), { a: "1" });
  assert.deepEqual(coerce("hstore", { a: "1" }, "h"), { a: "1" });
  checkHstoreSerialization(value);
});
