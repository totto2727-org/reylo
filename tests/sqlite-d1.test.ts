// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { Session } from "#reylo-source/analyze.ts";
import { forEachFixtureInOrder } from "./helpers.ts";
import { analyze, checkAnalysis, d1, DRIVER_ENV, IIF, migrate, PRETTY, withDrivers, worker } from "./sqlite-preflight-fixture.ts";

const assertAllowed = async (session: Session, statements: string[]): Promise<void> => {
  await forEachFixtureInOrder(statements, async (sql) => {
    const outcome = await checkAnalysis(session, sql);
    assert.deepEqual(outcome.analysis.diagnostics, [], sql);
  });
};

// Wrangler runs the local SQLite engine under workerd with D1's function restrictions.
// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a statement Cloudflare D1 refuses fails the type check at the call, with D1's message", { skip: d1, timeout: 120_000 }, async () => {
  await withDrivers(["wrangler"], async (root) => {
    await worker(root, true);
    const session = await Session.open(root, DRIVER_ENV);
    try {
      const CEILING = "select id, ceiling(id / 2.0) as half from notes";
      await forEachFixtureInOrder([[PRETTY, "json_pretty"], [CEILING, "ceiling"]] as const, async ([sql, functionName]) => {
        const outcome = await checkAnalysis(session, sql);
        const [diagnostic, ...rest] = outcome.analysis.diagnostics;
        assert.deepEqual(rest, []);
        assert.match(diagnostic?.message ?? "", new RegExp(`^Cloudflare D1, as wrangler \\d+\\.\\d+\\.\\d+ runs it locally, refuses this statement: not authorized to use function: ${functionName}$`, "u"));
        assert.deepEqual([diagnostic?.start, diagnostic?.length, diagnostic?.code], [sql.indexOf(functionName), functionName.length, 6]);
      });
      // What D1 allows compiles against the schema the type check read, its parameters bound.
      await assertAllowed(session, [
        "select id, ceil(id / 2.0) as half from notes where id = :id",
        "insert into notes (body, meta) values (:body, :meta) returning id",
        IIF,
      ]);
    } finally {
      await session.close();
    }
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a project whose wrangler config binds no D1 database is not asked, until its config binds one", { skip: d1, timeout: 120_000 }, async () => {
  await withDrivers(["wrangler"], async (root) => {
    await worker(root, false);
    await forEachFixtureInOrder(["original open", "cached start refusal"], async () => {
      const outcome = await analyze(root, PRETTY);
      assert.deepEqual(outcome.analysis.diagnostics, []);
    });
    // The failed start is remembered only as long as the config it read.
    await worker(root, true);
    const afterBinding = await analyze(root, PRETTY);
    assert.match(afterBinding.analysis.diagnostics[0]?.message ?? "", /refuses this statement: not authorized to use function: json_pretty$/u);
  });
});

const assertMigratedSchema = async (root: string): Promise<void> => {
  const TAGGED = "select id, tag from notes where tag = :tag";
  const session = await Session.open(root, DRIVER_ENV);
  try {
    await checkAnalysis(session, "select id from notes");
    // A migration adds a column and a table while the session runs.
    migrate(root);
    assert.equal(await session.recheck(), true);
    await assertAllowed(session, [TAGGED, "select name from tags"]);
  } finally {
    await session.close();
  }
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("D1 compiles each statement against the schema as it is now, after a migration and in a later session", { skip: d1, timeout: 120_000 }, async () => {
  await withDrivers(["wrangler"], async (root) => {
    await worker(root, true);
    await assertMigratedSchema(root);
    // A later session, as a build step opens after a pause, asks D1 again.
    const pretty = await analyze(root, "select json_pretty(tag) as t from notes");
    assert.match(pretty.analysis.diagnostics[0]?.message ?? "", /refuses this statement: not authorized to use function: json_pretty$/u);
  });
});
