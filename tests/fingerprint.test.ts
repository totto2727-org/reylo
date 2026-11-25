// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
import { engine } from "#reylo-source/engine.ts";
import { ENGINE_VERSION } from "#reylo-source/engine-version.ts";

// Published upstream binaries are versioned artifacts, not builds of this fork's Rust tree.
// Their reported fingerprint remains the cache identity, while the handshake checks compatibility.
// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the installed native SQLite engine reports its version and cache fingerprint", async () => {
  const currentEngine = await engine("sqlite");
  const ping = currentEngine.call({ op: "ping" });
  assert.ok("fingerprint" in ping && "version" in ping);
  assert.deepEqual([ping.database, ping.version], ["sqlite", ENGINE_VERSION]);
  assert.match(ping.fingerprint, /^[0-9a-f]{16}$/u);
  assert.equal(currentEngine.fingerprint, ping.fingerprint);
  assert.deepEqual(currentEngine.call({ answers: {}, dialect: "postgres", op: "analyze", sql: "select 1" }), {
    message: "this engine reads sqlite statements, not postgres ones", status: "error",
  });
});
