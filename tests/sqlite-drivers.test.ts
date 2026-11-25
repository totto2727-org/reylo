// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { Session } from "#reylo-source/analyze.ts";
import { placeRefusal, projectDrivers } from "#reylo-source/sqlite-drivers.ts";
import { forEachFixtureInOrder } from "./helpers.ts";
import { analyze, checkAnalysis, DRIVER_ENV, IIF, install, PRETTY, skip, withDrivers } from "./sqlite-preflight-fixture.ts";

// The libSQL driver carries SQLite 3.45.1, better-sqlite3 3.53 and sqlite3 3.52.
const bytes = (text: string): number => new TextEncoder().encode(text).length;

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a statement the app's SQLite refuses fails the type check at the call, with that SQLite's message", { skip }, async () => {
  await withDrivers(["@libsql/client"], async (root) => {
    const pretty = await analyze(root, PRETTY);
    assert.deepEqual(pretty.analysis.diagnostics, [
      { code: 6, length: "json_pretty".length, message: "@libsql/client runs SQLite 3.45.1, which refuses this statement: no such function: json_pretty", start: PRETTY.indexOf("json_pretty") },
    ]);
    const iif = await analyze(root, IIF);
    assert.deepEqual(iif.analysis.diagnostics, [
      { code: 6, length: 3, message: "@libsql/client runs SQLite 3.45.1, which refuses this statement: wrong number of arguments to function iif()", start: IIF.indexOf("iif") },
    ]);
    // What every SQLite takes is no error.
    const portable = await analyze(root, "select id, iif(id > 1, 'big', 'small') as size from notes");
    assert.deepEqual(portable.analysis.diagnostics, []);
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("drivers whose SQLite has the function prepare it, and a project that lists no driver is not checked", { skip }, async () => {
  await forEachFixtureInOrder([["better-sqlite3", "sqlite3"], []], async (drivers) => {
    await withDrivers(drivers, async (root) => {
      assert.deepEqual(projectDrivers(root), drivers);
      await forEachFixtureInOrder([PRETTY, IIF], async (sql) => {
        const outcome = await analyze(root, sql);
        assert.deepEqual(outcome.analysis.diagnostics, [], `${drivers.join(", ") || "no driver"}: ${sql}`);
      });
    });
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an analysis read from .reylo/ is checked on the drivers too", { skip }, async () => {
  await withDrivers([], async (root) => {
    const first = await analyze(root, PRETTY);
    assert.deepEqual([first.source, first.analysis.diagnostics], ["database", []]);
    // The project takes libSQL: the entry still matches the schema, and the driver refuses it.
    await install(root, ["@libsql/client"]);
    const second = await analyze(root, PRETTY);
    assert.equal(second.source, "cache");
    assert.match(second.analysis.diagnostics[0]?.message ?? "", /^@libsql\/client runs SQLite 3\.45\.1, which refuses this statement: no such function: json_pretty$/u);
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a session whose connection was released checks a statement it reads from .reylo/ all the same", { skip }, async () => {
  await withDrivers(["@libsql/client"], async (root) => {
    const session = await Session.open(root, DRIVER_ENV);
    try {
      const first = await checkAnalysis(session, PRETTY);
      assert.equal(first.analysis.diagnostics.length, 1);
      // A build step's session releases its connection once idle, while the schema it read is still trusted.
      await session.release();
      const second = await checkAnalysis(session, PRETTY);
      assert.equal(second.source, "cache");
      assert.match(second.analysis.diagnostics[0]?.message ?? "", /^@libsql\/client runs SQLite 3\.45\.1, which refuses this statement: no such function: json_pretty$/u);
    } finally {
      await session.close();
    }
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a refusal is placed at the call or the text it names, in UTF-8 bytes", () => {
  const sql = "-- café\nselect n.id from notes n right join notes m on m.id = n.id";
  const precedingText = sql.slice(0, sql.indexOf("right"));
  assert.deepEqual(placeRefusal(sql, 'near "right": syntax error'), { length: 5, start: bytes(precedingText) });
  assert.deepEqual(placeRefusal("select JSON_PRETTY (x) from t", "no such function: json_pretty"), { length: 11, start: 7 });
  // A message that names nothing in the statement points at its first word.
  assert.deepEqual(placeRefusal("  select 1", "unrecognized token"), { length: 6, start: 2 });
});
