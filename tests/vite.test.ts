// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to inspect or write files through the host filesystem.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
import reylo from "#reylo-source/vite.ts";

// The Cloudflare Vite plugin makes every `.sql` import in a Worker an external text module in its
// Own resolveId (`@cloudflare/vite-plugin` 1.64), so the import never reached Reylo's load hook and
// `.run` was undefined. Reylo's plugin now resolves a relative `.sql` import itself, in a resolveId
// Ordered "pre", which runs before every other plugin's wherever each is listed.
// oxlint-disable-next-line unicorn/no-null -- Vite uses null when a plugin declines to resolve an import.
const UNRESOLVED = null;

const queryProject = async function (): Promise<{ importer: string; root: string; queryPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "reylo-vite-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "queries"));
  const queryPath = path.join(root, "queries", "get_user.sql");
  await writeFile(queryPath, "select 1 as one");
  return { importer: path.join(root, "src", "worker.ts"), queryPath, root };
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("@totto2727/reylo/vite resolves a relative .sql import to its file before any other plugin can claim it", async () => {
  const { importer, root, queryPath } = await queryProject();
  const { resolveId } = reylo();
  assert.equal(resolveId.handler("../queries/get_user.sql", importer), queryPath);
  assert.equal(resolveId.handler("./get_user.sql", path.join(root, "queries", "index.ts")), queryPath);
  assert.equal(resolveId.handler("../queries/get_user.sql", `${importer}?v=1a2b`), queryPath);
  const declined: [string, string | undefined][] = [
    ["../queries/missing.sql", importer],
    ["queries/get_user.sql", importer],
    ["~/queries/get_user.sql", importer],
    ["../queries/get_user.txt", importer],
    ["../queries/get_user.sql", undefined],
    ["../queries/get_user.sql", "\0virtual:entry"],
  ];
  declined.forEach(([source, from]) => {assert.equal(resolveId.handler(source, from), UNRESOLVED);});
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("@totto2727/reylo/vite's resolveId runs before the other plugins' hooks", () => {
  assert.equal(reylo().resolveId.order, "pre");
});
