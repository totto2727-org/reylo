import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reylo from "../src/vite.ts";

// The Cloudflare Vite plugin makes every `.sql` import in a Worker an external text module in its
// own resolveId (`@cloudflare/vite-plugin` 1.64), so the import never reached Reylo's load hook and
// `.run` was undefined. Reylo's plugin now resolves a relative `.sql` import itself, in a resolveId
// ordered "pre", which runs before every other plugin's wherever each is listed.
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
  // specifier, another extension, an entry with no importer and a virtual importer.
  assert.equal(resolveId("../queries/missing.sql", importer), null);
  assert.equal(resolveId("queries/get_user.sql", importer), null);
  assert.equal(resolveId("~/queries/get_user.sql", importer), null);
  assert.equal(resolveId("../queries/get_user.txt", importer), null);
  assert.equal(resolveId("../queries/get_user.sql", undefined), null);
  assert.equal(resolveId("../queries/get_user.sql", "\0virtual:entry"), null);
});

test("@totto2727/reylo/vite's resolveId runs before the other plugins' hooks", () => {
  assert.equal(reylo().resolveId.order, "pre");
});
