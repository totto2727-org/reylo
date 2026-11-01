import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { defineQuery } from "@totto2727/reylo";
import { ENGINE_PACKAGES } from "../src/engine.ts";

const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the fork exposes its runtime and exact-version engines under its own scope", () => {
  assert.equal(manifest.name, "@totto2727/reylo");
  for (const dialect of ["postgres", "sqlite", "mysql", "duckdb"] as const) {
    const name = `@totto2727/reylo-${dialect}`;
    assert.equal(ENGINE_PACKAGES[dialect], name);
    const engine = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8"));
    assert.equal(engine.name, name);
    assert.equal(engine.version, manifest.version);
    assert.equal(manifest.peerDependencies[name], manifest.version);
    assert.equal(manifest.peerDependenciesMeta[name].optional, true);
  }
});

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
