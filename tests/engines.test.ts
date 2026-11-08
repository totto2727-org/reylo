import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { anyEngine, engine, enginePath, MissingEngine } from "../src/engine.ts";
import { resolveProject } from "../src/project.ts";

// An empty fallback install makes each project's own package determine engine resolution.
const SQLITE = fileURLToPath(new URL("../packages/sqlite", import.meta.url));
const nowhere = pathToFileURL(join(mkdtempSync(join(tmpdir(), "reylo-no-engines-")), "reylo.js")).href;
const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function project(version?: string): string {
  const root = mkdtempSync(join(tmpdir(), "reylo-engines-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "node_modules/@totto2727"), { recursive: true });
  if (version) {
    const at = join(root, "node_modules/@totto2727/reylo-sqlite");
    if (version === VERSION) symlinkSync(SQLITE, at);
    else {
      cpSync(SQLITE, at, { recursive: true });
      writeFileSync(join(at, "package.json"), JSON.stringify({ name: "@totto2727/reylo-sqlite", version, type: "module", exports: { "./engine/*": "./engine/*", "./package.json": "./package.json" } }));
    }
  }
  return root;
}

test("a project with no SQLite engine is told which package to install", async () => {
  const root = project();
  assert.equal(enginePath("sqlite", root, nowhere), undefined);
  await assert.rejects(engine("sqlite", root, nowhere), { name: "MissingEngine", message: "sqlite statements need @totto2727/reylo-sqlite: npm install -D @totto2727/reylo-sqlite" });
  writeFileSync(join(root, ".reylo.yaml"), "direct_url: file:./app.db\n");
  const reader = await anyEngine(root, nowhere);
  assert.ok(reader instanceof MissingEngine);
  assert.equal(resolveProject(reader, root, {}).error, ".reylo.yaml: reylo reads the project file with the SQLite engine, and none is installed: npm install -D @totto2727/reylo-sqlite");
});

test("unsupported dialects are refused without suggesting packages this fork does not publish", async () => {
  const root = project(VERSION);
  for (const dialect of ["postgres", "mysql", "duckdb"] as const) {
    assert.equal(enginePath(dialect, root, nowhere), undefined);
    await assert.rejects(engine(dialect, root, nowhere), { name: "MissingEngine", message: `This fork supports SQLite analysis only, not ${dialect} statements` });
  }
});

test("SQLite's engine reads the project file before opening its database", async () => {
  const root = project(VERSION);
  writeFileSync(join(root, ".reylo.yaml"), "direct_url: file:./app.db\n");
  const reader = await anyEngine(root, nowhere);
  assert.ok(!(reader instanceof MissingEngine));
  assert.equal(reader.call({ op: "ping" }).status, "ok");
  const resolved = resolveProject(reader, root, {});
  assert.deepEqual([resolved.dialect, resolved.error], ["sqlite", undefined]);
});

test("an engine of another version is refused with the matching version to install", async () => {
  const root = project("9.9.9");
  await assert.rejects(engine("sqlite", root, nowhere), (e: Error) => {
    assert.ok(e instanceof MissingEngine);
    assert.ok(e.message.startsWith(`reylo ${VERSION} runs with @totto2727/reylo-sqlite ${VERSION}, and the one installed is 9.9.9 (`), e.message);
    assert.ok(e.message.endsWith(`): npm install -D @totto2727/reylo-sqlite@${VERSION}`), e.message);
    return true;
  });
});

test("the project's SQLite engine comes before the fallback install and refuses other dialects", async () => {
  const root = project(VERSION);
  assert.equal(enginePath("sqlite", root, nowhere), join(SQLITE, "engine"));
  const e = await engine("sqlite", root, nowhere);
  const ping = e.call({ op: "ping" }) as { database?: string; fingerprint: string };
  assert.equal(ping.database, "sqlite");
  assert.match(ping.fingerprint, /^[0-9a-f]{16}$/);
  assert.deepEqual(e.call({ op: "analyze", sql: "select 1", dialect: "postgres", answers: {} }), { status: "error", message: "this engine reads sqlite statements, not postgres ones" });
});
