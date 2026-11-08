import { test } from "node:test";
import assert from "node:assert/strict";
import { engine } from "../src/engine.ts";
import { ENGINE_VERSION } from "../src/engine-version.ts";

// Published upstream binaries are versioned artifacts, not builds of this fork's Rust tree.
// Their reported fingerprint remains the cache identity, while the handshake checks compatibility.
test("the installed native SQLite engine reports its version and cache fingerprint", async () => {
  const e = await engine("sqlite");
  const ping = e.call({ op: "ping" }) as { database?: string; fingerprint: string; version: string };
  assert.deepEqual([ping.database, ping.version], ["sqlite", ENGINE_VERSION]);
  assert.match(ping.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(e.fingerprint, ping.fingerprint);
  assert.deepEqual(e.call({ op: "analyze", sql: "select 1", dialect: "postgres", answers: {} }), {
    status: "error", message: "this engine reads sqlite statements, not postgres ones",
  });
});
