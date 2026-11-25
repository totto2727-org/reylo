// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to use the host resolver for the installed driver or fixture package.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to inspect or write files through the host filesystem.
import { readFile } from "node:fs/promises";
import { defineQuery } from "@totto2727/reylo";
import { engine } from "#reylo-source/engine.ts";
import { isRecord } from "#reylo-source/native-predicates.ts";
// oxlint-disable-next-line import/no-relative-parent-imports -- Verify the checked-in source runtime manifest before publication.
import manifest from "../package.json" with { type: "json" };
// oxlint-disable-next-line import/no-relative-parent-imports -- Verify the checked-in source tooling manifest before publication.
import sqliteSource from "../packages/sqlite/package.json" with { type: "json" };

const require = createRequire(import.meta.url);
const SQLITE_PACKAGE = "@totto2727/reylo-sqlite";

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the fork exposes only its runtime and exact-version SQLite tooling under its own scope", async () => {
  assert.equal(manifest.name, "@totto2727/reylo");
  assert.deepEqual(manifest.peerDependencies, { "@totto2727/reylo-sqlite": manifest.version, effect: "^4.0.6" });
  assert.equal(manifest.peerDependenciesMeta.effect.optional, true);
  assert.equal(manifest.exports["./effect"], "./src/effect.ts");
  const installed: unknown = JSON.parse(await readFile(require.resolve(`${SQLITE_PACKAGE}/package.json`), "utf8"));
  assert.ok(isRecord(installed));
  assert.equal(installed.name, SQLITE_PACKAGE);
  assert.equal(installed.version, manifest.version);
  assert.equal(manifest.peerDependencies[SQLITE_PACKAGE], manifest.version);
  assert.equal(manifest.peerDependenciesMeta[SQLITE_PACKAGE].optional, true);
});

Iterator.from(["postgres", "mysql", "duckdb"] as const).forEach((dialect) => {
  // oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
  test(`the fork refuses ${dialect} analysis without discovering an engine package`, async () => {
    await assert.rejects(engine(dialect), {
      message: `This fork supports SQLite analysis only, not ${dialect} statements`,
      name: "MissingEngine",
    });
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the scoped public runtime preserves the Standard Query contract", () => {
  const {query} = defineQuery<{ id: number }, { id: number }, "one", "sqlite">({
    cardinality: "one",
    columns: [["id", "int"]],
    dialect: "sqlite",
    inputs: { id: { nullable: false, type: { kind: "scalar", name: "int" } } },
    params: ["id"],
    sql: "select :id as id",
    text: "select ? as id",
  })["~standard"];
  assert.equal(query.text, "select ? as id");
  assert.deepEqual(query.encode({ id: 7 }), [7]);
  assert.deepEqual(query.decode([[7]]), { id: 7 });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("source packages stay private while distributions target public npm publication", () => {
  [manifest, sqliteSource].forEach((source) => {
    assert.equal(source.private, true);
    assert.deepEqual(source.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
  });
});
