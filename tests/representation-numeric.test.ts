// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs these real driver cases through Node's test runner.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Use native assertions to compare each driver's returned values and errors.
import assert from "node:assert/strict";
import { forEachFixtureInOrder, SQL_NULL } from "./helpers.ts";
import { built, loadLibsql, plain, representationOptions, withLabProject } from "./sqlite-driver-lab-fixture.ts";

// `ok + 0` is a REAL's expression on a column declared BOOLEAN, and what SQLite computes from the
// Stored 2 is the INTEGER 2; `z` is a NUMERIC column, which stores 7 and 9007199254740991 as
// INTEGERs and 2.5 and 'abc' as they are; `x` has no type.
const SCHEMA = `create table t (id integer primary key, ok boolean, z numeric, x);
    insert into t values (1, 2, 7, 7), (2, 2, 2.5, 'abc'), (3, 2, 'abc', '7'), (4, 2, 9007199254740991, null);
    create table past (id integer primary key, z numeric); insert into past values (1, 9007199254740992)`;

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("SQLite: libSQL's intMode \"string\" changes no value Reylo types a number or a NUMERIC's: an INTEGER is its number, exact up to 2^53 - 1 and refused past it; a column with no type keeps libSQL's digits", representationOptions, async () => {
  const createClient = loadLibsql();
  await withLabProject(SCHEMA, async ({ file, root }) => {
    const computed = await built(root, "computed", "select id, ok + 0 as n, ok + 9007199254740989 as edge, z, x from t order by id");
    const over = await built(root, "computed_over", "select ok + 9007199254740990 as edge from t where id = 1");
    const past = await built(root, "numeric_past", "select z from past");
    await forEachFixtureInOrder(["number", "bigint", "string"], async (intMode) => {
      const client = createClient({ intMode, url: `file:${file}` });
      const digits = intMode === "string";
      assert.deepEqual(
        plain(await computed.run(client)),
        [
          // A column with no type cannot tell libSQL's digits from a TEXT's: it keeps what libSQL gives.
          { edge: 9_007_199_254_740_991, id: 1, n: 2, x: digits ? "7" : 7, z: 7 },
          { edge: 9_007_199_254_740_991, id: 2, n: 2, x: "abc", z: 2.5 },
          { edge: 9_007_199_254_740_991, id: 3, n: 2, x: "7", z: "abc" },
          { edge: 9_007_199_254_740_991, id: 4, n: 2, x: SQL_NULL, z: 9_007_199_254_740_991 },
        ],
        `libSQL with intMode ${intMode}`,
      );
      // One past 2^53 - 1: libSQL's intMode "number" refuses it itself; the others hand it over exact, and Reylo refuses it.
      const refused = intMode === "number" ? RangeError : /Column "edge" holds 9007199254740992, an integer past/u;
      await assert.rejects(over.run(client), refused, `libSQL with intMode ${intMode}: a REAL's expression past 2^53 - 1`);
      await assert.rejects(past.run(client), intMode === "number" ? RangeError : /Column "z" holds 9007199254740992, an integer past/u, `libSQL with intMode ${intMode}: a NUMERIC past 2^53 - 1`);
      client.close();
    });
  });
});
