// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
import { runChild } from "./helpers.ts";

const runtime = new URL("../src/index.ts", import.meta.url).href;

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the ordinary runtime executes without loading the optional Effect peer", async () => {
  const result = await runChild(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "effect" || specifier.startsWith("effect/")) {
          throw new Error("The ordinary runtime must not load Effect");
        }
        return nextResolve(specifier, context);
      }
    });
    const { defineQuery } = await import(${JSON.stringify(runtime)});
    const database = new DatabaseSync(":memory:");
    try {
      const query = defineQuery({
        dialect: "sqlite", sql: "select 7 as n", params: [],
        columns: [["n", "int"]], cardinality: "one"
      });
      assert.deepEqual(query.runSync(database), { n: 7 });
      process.stdout.write("ok");
    } finally {
      database.close();
    }
  `], { cwd: process.cwd() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ok");
});
