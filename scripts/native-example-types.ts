// oxlint-disable-next-line rules/no-node-imports -- Verify the bytes the examples supply to the lint compiler.
import { equal } from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Discover native example queries and maintain their generated declarations.
import { readdir, readFile, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve both independently installed examples from the repository.
import path from "node:path";
import { isEmptyString } from "#reylo-source/native-predicates.ts";
import { mapSqlTypes } from "./example-sql-types.ts";

const ROOT = path.join(import.meta.dirname, "../examples");
const GENERATED_HEADER = "// Generated from the SQL by scripts/native-example-types.ts.\n";
const REGENERATE = "Run nub scripts/native-example-types.ts --write from the repository root.";
const write = process.argv.includes("--write");

const block = (specifier: string, source: string): string => {
  // These const declarations are already ambient inside the module.
  const body = source.trimEnd()
    .replaceAll(/^(?<exported>export )?declare const /gmu, "$<exported>const ")
    // The declaration's type-only alias lets root lint resolve Reylo before the example is installed.
    .replaceAll(/(?<=from |import\()"@totto2727\/reylo"/gu, '"#reylo-example-types"');
  const lines = body.split("\n").map((line) => isEmptyString(line) ? line : `  ${line}`);
  return `declare module ${JSON.stringify(specifier)} {\n${lines.join("\n")}\n}\n`;
};

const check = async (destination: string, modules: ReadonlyMap<string, string>, prefix: string): Promise<void> => {
  const blocks = Array.from(modules, ([name, text]) => block(`${prefix}${name}`, text));
  const declaration = GENERATED_HEADER + blocks.join("\n");
  if (write) {
    await writeFile(destination, declaration);
    return;
  }
  equal(await readFile(destination, "utf8"), declaration, `${destination} differs from the content mapper output. ${REGENERATE}`);
};

const nub = path.join(ROOT, "nub");
const nubFiles = await readdir(path.join(nub, "queries"));
const nubTypes = await mapSqlTypes({
  directory: nub,
  queries: "queries",
  schema: { filename: "setup.sql", kind: "sqlite" },
}, nubFiles.filter((name) => name.endsWith(".sql")));
await check(path.join(nub, "src", "sql-types.d.ts"), nubTypes, "*/queries/");

const hcl = path.join(ROOT, "hcl");
const hclFiles = await readdir(hcl);
const hclTypes = await mapSqlTypes({
  directory: hcl,
  queries: ".",
  schema: { filename: "schema.hcl", kind: "hcl" },
}, hclFiles.filter((name) => name.endsWith(".sql")));
await check(path.join(hcl, "sql-types.d.ts"), hclTypes, "*/");
