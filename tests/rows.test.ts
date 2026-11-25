// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import type { EngineType } from "#reylo-source/engine.ts";
import { renderParamType } from "#reylo-source/render.ts";
import { prepareRows, variant } from '#reylo-source/rows.ts';
import type { RowsType } from '#reylo-source/rows.ts';
import { nativeDriverDate, SQL_NULL } from "./helpers.ts";
import { matchesBigInt } from "#reylo-source/native-predicates.ts";

// What the engine gives for `:events::rows(id int8 not null, ts timestamptz not null, status? text
// Not null, amount numeric(12,2), tags text[], meta jsonb('{"type": "object", …}'))`.
const scalar = (name: string): EngineType => ({ kind: "scalar", name });
const statusField: RowsType["fields"][number] = {
  name: "status", nullable: false, optional: true, type: scalar("text"), written: "text",
};
const metaSchema = { properties: { source: { type: "string" } }, required: ["source"], type: "object" };
const events: RowsType = {
  fields: [
    { name: "id", nullable: false, optional: false, type: scalar("int8"), written: "int8" },
    { name: "ts", nullable: false, optional: false, type: scalar("timestamptz"), written: "timestamptz" },
    statusField,
    { name: "amount", nullable: true, optional: true, type: scalar("numeric"), written: "numeric(12,2)" },
    { name: "tags", nullable: true, optional: true, type: { kind: "array", of: scalar("text") }, written: "text[]" },
    {
      name: "meta",
      nullable: true,
      optional: true,
      schema: metaSchema,
      type: { kind: "json", schema: { additionalProperties: true, ...metaSchema } },
      written: "jsonb",
    },
  ],
  kind: "rows",
  one: false,
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the caller's type is the column list's: each key as its parameter type takes it, ? where it may be left out, | null where it may be null", () => {
  assert.equal(
    renderParamType(events, "postgres"),
    "readonly { id: number | bigint | string; ts: string; status?: string; amount?: string | null; tags?: (string | null)[] | null; meta?: { source: string } | null }[]",
  );
  assert.equal(renderParamType({ ...events, fields: events.fields.slice(0, 1), one: true }, "postgres"), "{ id: number | bigint | string }");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a value is checked against its column list, and written as the JSON the statement reads", () => {
  const row = { amount: "1.50", id: BigInt("9007199254740993"), meta: { source: "x" }, status: "done", tags: ["a"], ts: "2026-10-20T10:00:00.000Z" };
  // Postgres reads a 64-bit integer from its digits exactly, and the run time binds the JSON value.
  assert.deepEqual(prepareRows("events", events, [row], "postgres", true).value, [{ amount: "1.50", id: "9007199254740993", meta: { source: "x" }, status: "done", tags: ["a"], ts: "2026-10-20T10:00:00.000Z" }]);
  // MySQL and SQLite take the JSON text, with the integer a bare number.
  assert.equal(prepareRows("events", events, [row], "mysql", true).value, `[{"id":9007199254740993,"ts":"2026-10-20T10:00:00.000Z","status":"done","amount":"1.50","tags":["a"],"meta":{"source":"x"}}]`);
  const refused: [unknown, RegExp][] = [
    [{ ts: "2026-10-20T10:00:00Z" }, /row 1: "id" is int8 not null, and the row leaves it out/u],
    [{ id: 1, status: SQL_NULL, ts: "2026-10-20T10:00:00Z" }, /"status" is text not null, and the row gives null; leave the key out for the column's default/u],
    [{ id: 1, stauts: "x", ts: "2026-10-20T10:00:00Z" }, /the column list names no key "stauts"/u],
    [{ id: 2 ** 53, ts: "2026-10-20T10:00:00Z" }, /past 2\^53 - 1/u],
    [{ id: BigInt("2") ** BigInt("63"), ts: "2026-10-20T10:00:00Z" }, /from -9223372036854775808 to 9223372036854775807/u],
    [{ id: 1.5, ts: "2026-10-20T10:00:00Z" }, /"id" is int8, an integer; got 1\.5/u],
    [{ id: 1, ts: "2026-10-20 10:00" }, /names its zone/u],
    [{ id: 1, ts: nativeDriverDate() }, /not a Date: pass date.toISOString\(\)/u],
    [{ amount: "1.234", id: 1, ts: "2026-10-20T10:00:00Z" }, /keeps 2 digits after the point, so 1\.234 would be rounded/u],
    [{ amount: "12345678901", id: 1, ts: "2026-10-20T10:00:00Z" }, /at most 10 digits before the point/u],
    [{ id: 1, tags: ["a", 1], ts: "2026-10-20T10:00:00Z" }, /"tags" element 2 is text, a string; got 1/u],
    [{ id: 1, meta: { n: BigInt("1") }, ts: "2026-10-20T10:00:00Z" }, /holds a JSON value/u],
  ];
  Iterator.from(refused).forEach(([value, message]) => {assert.throws(() => prepareRows("events", events, [value], "postgres", true), message, JSON.stringify(value, (_key, item: unknown) => (matchesBigInt(item) ? `${item}n` : item)));});
  assert.throws(() => prepareRows("events", events, { id: 1 }, "postgres", true), /pass an array of objects, one per row; got an object/u);
  assert.throws(() => prepareRows("user", { ...events, one: true }, [], "postgres", true), /each row is an object/u);
});

const quotedColumns = (prefix: string): string[] => ["id", "ts", "status", "amount", "tags", "meta"].map((name) => `${prefix}"${name}"`);

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the rows an insert writes carry the same keys, and its lists name only those", () => {
  const row = { id: 1, ts: "2026-10-20T10:00:00Z" };
  assert.throws(() => prepareRows("events", events, [row, { ...row, status: "x" }], "postgres", true), /row 2 gives "status", which row 1 leaves out/u);
  // Elsewhere a key left out reads as NULL, so the rows may differ.
  assert.doesNotThrow(() => prepareRows("events", { ...events, fields: events.fields.filter((field) => field.name !== "status") }, [row, { ...row, amount: 1 }], "postgres", false));
  const { present } = prepareRows("events", events, [row, row], "postgres", true);
  const text = `insert into events ("id", "ts", "status", "amount", "tags", "meta") SELECT e."id", e."ts", e."status", e."amount", e."tags", e."meta" FROM x`;
  const list = (columns: string[]): { end: number; entries: string[]; start: number } => {
    const names = columns.join(", ");
    const start = text.indexOf(names);
    return { end: start + names.length, entries: columns, start };
  };
  const structured = { lists: [list(quotedColumns("")), list(quotedColumns("e."))], name: "events" };
  assert.equal(variant(text, structured, events.fields, present), `insert into events ("id", "ts") SELECT e."id", e."ts" FROM x`);
  assert.throws(() => prepareRows("p", { fields: [{ ...statusField }], kind: "rows", one: true }, {}, "postgres", true), /every key is left out/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a pgvector vector member takes an array of finite numbers, written as the text pgvector reads", () => {
  const items: RowsType = {
    fields: [
      { name: "embedding", nullable: false, optional: false, type: scalar("vector"), written: "vector(3)" },
      { name: "history", nullable: true, optional: true, type: { kind: "array", of: scalar("halfvec") }, written: "halfvec[]" },
    ],
    kind: "rows",
    one: false,
  };
  assert.equal(renderParamType(items), "readonly { embedding: number[]; history?: (number[] | null)[] | null }[]");
  assert.deepEqual(prepareRows("items", items, [{ embedding: [1, 2.5, 3], history: [[0.5], SQL_NULL] }], "postgres", true).value, [{ embedding: "[1,2.5,3]", history: ["[0.5]", SQL_NULL] }]);
  Iterator.from([[], [1, Number.NaN], ["1"], "x".length]).forEach((embedding) => {assert.throws(() => prepareRows("items", items, [{ embedding }], "postgres", true), /embedding.* is vector\(3\), an array of finite numbers with one at least/u);});
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an hstore member takes an object of its keys, written as the text hstore reads", () => {
  const settings: RowsType = {
    fields: [{ name: "prefs", nullable: false, optional: false, type: scalar("hstore"), written: "hstore" }],
    kind: "rows",
    one: true,
  };
  assert.equal(renderParamType(settings), "{ prefs: Record<string, string | null> }");
  const prefs = Object.fromEntries([["theme", "dark"], ["gone", SQL_NULL]]);
  assert.deepEqual(prepareRows("settings", settings, { prefs }, "postgres", true).value, { prefs: '"theme"=>"dark", "gone"=>NULL' });
  assert.throws(() => prepareRows("settings", settings, { prefs: { n: 1 } }, "postgres", true), /prefs.* is hstore, whose values are strings or null, and its key "n" holds 1/u);
  assert.throws(() => prepareRows("settings", settings, { prefs: 1 }, "postgres", true), /prefs.* is hstore, an object of its keys/u);
});
