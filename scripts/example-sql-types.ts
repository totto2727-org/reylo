// oxlint-disable-next-line rules/no-node-imports -- Validate the actual content mapper's generated responses.
import { ok } from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Keep each generated type check in its own temporary schema directory.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Generate declarations against the sample's actual SQLite schema.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- Locate the system's temporary directory for analysis.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- Resolve SQL, config, and schema paths on the host.
import path from "node:path";
import { mapperHandlers } from "#reylo-source/mapper-server.ts";
import { isEmptyArray, isRecord, matchesString, matchesUndefined } from "#reylo-source/native-predicates.ts";

interface Example {
  directory: string;
  queries: string;
  schema: { kind: "sqlite" | "hcl"; filename: string };
}

const writeSchema = async (directory: string, example: Example): Promise<string> => {
  const source = await readFile(path.join(example.directory, example.schema.filename), "utf8");
  if (example.schema.kind === "hcl") {
    await writeFile(path.join(directory, "schema.hcl"), source);
    return "hcl:./schema.hcl";
  }
  const database = new DatabaseSync(path.join(directory, "app.db"));
  try {
    database.exec(source);
  } finally {
    database.close();
  }
  return "file:./app.db";
};

const overrideConfig = (filename: string): (() => void) => {
  // oxlint-disable-next-line node/no-process-env -- The content mapper reads REYLO_CONFIG to use its private schema fixture.
  const environment = process.env;
  const previous = environment.REYLO_CONFIG;
  environment.REYLO_CONFIG = filename;
  return () => {
    if (matchesUndefined(previous)) {delete environment.REYLO_CONFIG;}
    else {environment.REYLO_CONFIG = previous;}
  };
};

type Transform = NonNullable<ReturnType<typeof mapperHandlers>["transform"]>;

const readTypes = async (
  { directory, queries }: Example,
  { names, projectHandle }: { names: string[]; projectHandle: string },
  transform: Transform,
): Promise<ReadonlyMap<string, string>> => {
  const declarations = new Map<string, string>();
  // oxlint-disable-next-line rules/no-for-loops -- Run each example statement in sorted order against its single mapper session.
  for (const name of names.toSorted()) {
    const fileName = path.join(directory, queries, name);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each analysis receives that file's SQL bytes before starting.
    const content = await readFile(fileName, "utf8");
    // oxlint-disable-next-line eslint/no-await-in-loop -- The next statement waits for the same native mapper session to finish.
    const response = await transform({ content, fileName, projectHandle });
    ok(isRecord(response) && matchesString(response.text) && Array.isArray(response.diagnostics), `Unexpected content mapper response for ${name}`);
    ok(isEmptyArray(response.diagnostics), `Cannot generate ${name}: ${JSON.stringify(response.diagnostics)}`);
    declarations.set(name, response.text);
  }
  return declarations;
};

const mapExample = async (example: Example, names: string[], projectHandle: string): Promise<ReadonlyMap<string, string>> => {
  const { closeProject, openProject, transform } = mapperHandlers();
  ok(openProject && transform && closeProject, "The Reylo content mapper requires project and transform handlers");
  await openProject({ configFileName: path.join(example.directory, "tsconfig.json"), projectHandle });
  try {
    return await readTypes(example, { names, projectHandle }, transform);
  } finally {
    await closeProject({ projectHandle });
  }
};

export const mapSqlTypes = async (example: Example, names: string[]): Promise<ReadonlyMap<string, string>> => {
  const directory = await mkdtemp(path.join(tmpdir(), "reylo-example-declarations-"));
  try {
    const url = await writeSchema(directory, example);
    const config = path.join(directory, ".reylo.yaml");
    await writeFile(config, `direct_url: ${url}\n`);
    const restore = overrideConfig(config);
    try {
      return await mapExample(example, names, directory);
    } finally {
      restore();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};
