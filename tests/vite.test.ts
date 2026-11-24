// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to inspect or write files through the host filesystem.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import { join } from "node:path";
import reylo from "#reylo-source/vite.ts";

// The Cloudflare Vite plugin makes every `.sql` import in a Worker an external text module in its
// Own resolveId (`@cloudflare/vite-plugin` 1.64), so the import never reached Reylo's load hook and
// `.run` was undefined. Reylo's plugin now resolves a relative `.sql` import itself, in a resolveId
// Ordered "pre", which runs before every other plugin's wherever each is listed.
// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("@totto2727/reylo/vite resolves a relative .sql import to its file before any other plugin can claim it", () => {
  const root = mkdtempSync(join(tmpdir(), "reylo-vite-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "queries"));
  writeFileSync(join(root, "queries", "get_user.sql"), "select 1 as one");
  const importer = join(root, "src", "worker.ts");
  const resolveId = reylo().resolveId.handler;
  assert.equal(resolveId("../queries/get_user.sql", importer), join(root, "queries", "get_user.sql"));
  assert.equal(resolveId("./get_user.sql", join(root, "queries", "index.ts")), join(root, "queries", "get_user.sql"));
  // Vite's importer may carry a query.
  assert.equal(resolveId("../queries/get_user.sql", `${importer}?v=1a2b`), join(root, "queries", "get_user.sql"));
  // Everything else is left to Vite: a missing file (Vite's own error), a bare or aliased
  // Specifier, another extension, an entry with no importer and a virtual importer.
  assert.equal(resolveId("../queries/missing.sql", importer), null);
  assert.equal(resolveId("queries/get_user.sql", importer), null);
  assert.equal(resolveId("~/queries/get_user.sql", importer), null);
  assert.equal(resolveId("../queries/get_user.txt", importer), null);
  assert.equal(resolveId("../queries/get_user.sql", undefined), null);
  assert.equal(resolveId("../queries/get_user.sql", "\0virtual:entry"), null);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("@totto2727/reylo/vite's resolveId runs before the other plugins' hooks", () => {
  assert.equal(reylo().resolveId.order, "pre");
});
