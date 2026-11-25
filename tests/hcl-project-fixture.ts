// oxlint-disable-next-line rules/no-node-imports -- Create and remove the disposable HCL schema project.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Build schema and test paths on the current host.
import path from "node:path";
import { Session } from "#reylo-source/analyze.ts";
import { engine } from "#reylo-source/engine.ts";
import { hclCatalog } from "#reylo-source/hcl.ts";
import { sqlModule } from "#reylo-source/loader.ts";
import { forEachFixtureInOrder, ROOT } from "./helpers.ts";

export const TMP = path.join(ROOT, "tmp");
export const SELECT = "select id, name from users where id = :id";

export const schema = (nullable = false): string => `schema "main" {}
table "users" {
  schema = schema.main
  column "id" {
    type = integer
    null = false
  }
  column "name" {
    type = text
    null = ${nullable}
  }
  primary_key {
    columns = [column.id]
  }
}
`;

export const schemaFile = (root: string): string => path.join(root, "schema.hcl");

export const catalogReader = async (): Promise<(filename: string) => ReturnType<typeof hclCatalog>> => {
  const sqlite = await engine("sqlite");
  return (filename) => hclCatalog(filename, sqlite);
};

export const compileHclQuery = async (root: string): ReturnType<typeof sqlModule> =>
  sqlModule(path.join(root, "get.sql"), SELECT);

const removeProject = async (root: string): Promise<void> => {
  const sessions = Session.opened().filter((current) => current.root === root);
  try {
    await forEachFixtureInOrder(sessions, async (current) => {await current.close();});
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

export const withHclProject = async (check: (root: string) => Promise<void>): Promise<void> => {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(path.join(TMP, "reylo-hcl-"));
  try {
    await writeFile(path.join(root, "package.json"), "{}");
    await writeFile(path.join(root, ".reylo.yaml"), "direct_url: hcl:./schema.hcl\n");
    await writeFile(schemaFile(root), schema());
    await check(root);
  } finally {
    await removeProject(root);
  }
};

export const hasDatabaseFiles = async (root: string): Promise<boolean> => {
  const files = await readdir(root);
  return files.some((name) => /\.(?:db|sqlite)(?:-|$)/u.test(name));
};
