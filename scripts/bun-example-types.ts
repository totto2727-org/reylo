// oxlint-disable-next-line rules/no-node-imports -- Compare checked-in declarations to the native mapper output.
import { equal, ok } from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Read SQL filenames and update the source-controlled declarations.
import { readdir, readFile, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the standalone example's sources and declarations.
import path from "node:path";
import { isEmptyArray } from "#reylo-source/native-predicates.ts";
import { mapSqlTypes } from "./example-sql-types.ts";

const EXAMPLE = path.join(import.meta.dirname, "../examples/bun");
const QUERIES = path.join(EXAMPLE, "queries");
const DECLARATION_SUFFIX = ".d.sql.ts";
const GENERATED_HEADER = "// Generated from the SQL by scripts/bun-example-types.ts.\n";
const REGENERATE = "Run nub scripts/bun-example-types.ts --write from the repository root.";

const files = await readdir(QUERIES);
const types = await mapSqlTypes({
  directory: EXAMPLE,
  queries: "queries",
  schema: { filename: "setup.sql", kind: "sqlite" },
}, files.filter((name) => name.endsWith(".sql")));
const declarations = new Map(Array.from(types, ([name, text]) => [name.replace(/\.sql$/u, DECLARATION_SUFFIX), GENERATED_HEADER + text]));
const orphaned = files.filter((name) => name.endsWith(DECLARATION_SUFFIX) && !declarations.has(name));
ok(isEmptyArray(orphaned), `No source SQL for ${orphaned.join(", ")}. Remove the obsolete declarations.`);
const write = process.argv.includes("--write");
await Promise.all(Array.from(declarations, async ([name, text]) => {
  const fileName = path.join(QUERIES, name);
  if (write) {
    await writeFile(fileName, text);
    return;
  }
  equal(await readFile(fileName, "utf8"), text, `${name} differs from the content mapper output. ${REGENERATE}`);
}));
