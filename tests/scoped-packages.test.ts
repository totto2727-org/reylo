import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { defineQuery } from "@totto2727/reylo";
import { ENGINE_PACKAGES, engine, enginePath } from "../src/engine.ts";

const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the fork exposes only its runtime and exact-version SQLite engine under its own scope", () => {
  assert.equal(manifest.name, "@totto2727/reylo");
  assert.deepEqual(ENGINE_PACKAGES, { sqlite: "@totto2727/reylo-sqlite" });
  assert.deepEqual(manifest.peerDependencies, { "@totto2727/reylo-sqlite": manifest.version });
  for (const dialect of ["sqlite"] as const) {
    const name = `@totto2727/reylo-${dialect}`;
    assert.equal(ENGINE_PACKAGES[dialect], name);
    const engine = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8"));
    assert.equal(engine.name, name);
    assert.equal(engine.version, manifest.version);
    assert.equal(manifest.peerDependencies[name], manifest.version);
    assert.equal(manifest.peerDependenciesMeta[name].optional, true);
  }
});

for (const dialect of ["postgres", "mysql", "duckdb"] as const) {
  test(`the fork refuses ${dialect} analysis without discovering an engine package`, async () => {
    assert.equal(enginePath(dialect, import.meta.dirname), undefined);
    await assert.rejects(engine(dialect, import.meta.dirname), {
      name: "MissingEngine",
      message: `This fork supports SQLite analysis only, not ${dialect} statements`,
    });
  });
}

test("the scoped public runtime preserves the Standard Query contract", () => {
  const query = defineQuery<{ id: number }, { id: number }, "one", "sqlite">({
    dialect: "sqlite", sql: "select :id as id", text: "select ? as id", params: ["id"],
    inputs: { id: { type: { kind: "scalar", name: "int" }, nullable: false } },
    columns: [["id", "int"]], cardinality: "one",
  })["~standard"].query;
  assert.equal(query.text, "select ? as id");
  assert.deepEqual(query.encode({ id: 7 }), [7]);
  assert.deepEqual(query.decode([[7]]), { id: 7 });
});

test("source packages stay private while distributions target public npm publication", () => {
  for (const path of ["../package.json", "../packages/sqlite/package.json"]) {
    const source = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    assert.equal(source.private, true);
    assert.deepEqual(source.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
  }
});
