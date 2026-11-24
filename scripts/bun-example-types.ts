// oxlint-disable-next-line rules/no-node-imports -- The repository check uses Node assertions for generated output.
import { equal, ok } from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The repository check reads SQL and compares files through the host filesystem.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Each verification uses a private directory under the system temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- Build paths for the repository fixture and the temporary database on the host.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Seed the sample schema in a private database using the Node 24 toolchain.
import { DatabaseSync } from "node:sqlite";
import { mapperHandlers } from "#reylo-source/mapper-server.ts";
import { isEmptyArray, isRecord, matchesString } from "#reylo-source/native-predicates.ts";

const { join } = path;
const EXAMPLE = join(import.meta.dirname, "../examples/bun");
const QUERIES = join(EXAMPLE, "queries");
const DECLARATION_SUFFIX = ".d.sql.ts";
const GENERATED_HEADER = "// Generated from the SQL by scripts/bun-example-types.ts.\n";
const REGENERATE = "Run nub scripts/bun-example-types.ts --write from the repository root.";

const prepareDatabase = async (directory: string): Promise<void> => {
  const schema = await readFile(join(EXAMPLE, "setup.sql"), "utf8");
  const database = new DatabaseSync(join(directory, "app.db"));
  try {
    database.exec(schema);
  } finally {
    database.close();
  }

  const config = join(directory, ".reylo.yaml");
  await writeFile(config, "direct_url: file:./app.db\n");
  // oxlint-disable-next-line node/no-process-env -- This command points the content mapper at its private SQLite fixture.
  process.env.REYLO_CONFIG = config;
};

type Transform = NonNullable<ReturnType<typeof mapperHandlers>["transform"]>;

const renderQueries = async (names: string[], projectHandle: string, transform: Transform): Promise<ReadonlyMap<string, string>> => {
  const queries = await Promise.all(names.toSorted().map(async (name) => {
    const fileName = join(QUERIES, name);
    return { content: await readFile(fileName, "utf8"), fileName, name };
  }));
  const declarations = new Map<string, string>();
  // oxlint-disable-next-line rules/no-for-loops -- Run the mapper against one SQLite project in pathname order.
  for (const { content, fileName, name } of queries) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each analysis completes before the next can use the same mapper session.
    const response = await transform({ content, fileName, projectHandle });
    ok(isRecord(response) && matchesString(response.text) && Array.isArray(response.diagnostics), `Unexpected content mapper response for ${name}`);
    ok(isEmptyArray(response.diagnostics), `Cannot generate ${name}: ${JSON.stringify(response.diagnostics)}`);
    declarations.set(name.replace(/\.sql$/u, DECLARATION_SUFFIX), GENERATED_HEADER + response.text);
  }
  return declarations;
};

const generate = async (directory: string, queries: string[]): Promise<ReadonlyMap<string, string>> => {
  await prepareDatabase(directory);
  const { closeProject, openProject, transform } = mapperHandlers();
  ok(openProject && transform && closeProject, "The Reylo content mapper requires project and transform handlers");
  const projectHandle = directory;
  await openProject({ configFileName: join(EXAMPLE, "tsconfig.json"), projectHandle });
  try {
    return await renderQueries(queries, projectHandle, transform);
  } finally {
    await closeProject({ projectHandle });
  }
};

const files = await readdir(QUERIES);
const directory = await mkdtemp(join(tmpdir(), "reylo-bun-declarations-"));
try {
  const declarations = await generate(directory, files.filter((name) => name.endsWith(".sql")));
  const orphaned = files.filter((name) => name.endsWith(DECLARATION_SUFFIX) && !declarations.has(name));
  ok(isEmptyArray(orphaned), `No source SQL for ${orphaned.join(", ")}. Remove the obsolete declarations.`);
  const write = process.argv.includes("--write");
  await Promise.all(Array.from(declarations, async ([name, text]) => {
    const fileName = join(QUERIES, name);
    if (write) {
      await writeFile(fileName, text);
      return;
    }
    equal(await readFile(fileName, "utf8"), text, `${name} differs from the content mapper output. ${REGENERATE}`);
  }));
} finally {
  await rm(directory, { force: true, recursive: true });
}
