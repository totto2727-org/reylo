// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Build a temporary project for the real TypeScript CLI.
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
import { ROOT, runChild } from "./helpers.ts";

// The setup lists `.reylo.yaml` and `.reylo.yml` among the content mapper's extensions beside `.sql`,
// So the project file is the mapper's to type rather than a YAML loader's. Its module declares
// Nothing, and neither an import of it nor a `<name>.reylo.yaml` that `include` takes in is read as a
// Query. The type check runs as a project runs it, over SQLite, so no server is needed.
// TypeScript's own launcher, run by this Node: node_modules/.bin holds a shell script, which Windows cannot start.
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

const writeProjectFiles = async function (root: string): Promise<void> {
  await writeFile(path.join(root, "package.json"), `{ "type": "module" }`);
  await writeFile(path.join(root, ".env"), "DATABASE_URL=file:./app.db\n");
  await writeFile(path.join(root, ".reylo.yaml"), "# the project file\nstrict_params: true\n");
  await mkdir(path.join(root, "config"));
  await writeFile(path.join(root, "config", "staging.reylo.yaml"), "strict_params: true\n");
  await writeFile(path.join(root, "config", "local.reylo.yml"), "strict_params: true\n");
  await writeFile(path.join(root, "posts.sql"), "select id, title from posts where id > :after::integer\n");
  await writeFile(
    path.join(root, "main.ts"),
    [
      `import posts from "./posts.sql";`,
      `import type * as project from "./.reylo.yaml";`,
      `import type * as local from "./config/local.reylo.yml";`,
      `// @ts-expect-error the project file's module has no default export`,
      `import config from "./.reylo.yaml";`,
      `export const query = posts;`,
      `export type Project = typeof project | typeof local;`,
      `export const unused = config;`,
      ``,
    ].join("\n"),
  );
};

const installProject = async function (root: string): Promise<void> {
  const db = new DatabaseSync(path.join(root, "app.db"));
  try {
    db.exec("create table posts (id integer primary key, title text not null)");
  } finally {
    db.close();
  }
  await mkdir(path.join(root, "node_modules", "@totto2727"), { recursive: true });
  await symlink(ROOT, path.join(root, "node_modules", "@totto2727/reylo"));
  await symlink(path.join(ROOT, "packages", "sqlite"), path.join(root, "node_modules", "@totto2727", "reylo-sqlite"));
};

const config = {
  compilerOptions: {
    allowImportingTsExtensions: true,
    lib: ["esnext"],
    module: "nodenext",
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: "esnext",
    types: [],
  },
  contentMappers: [{ extensions: [".sql", ".reylo.yaml", ".reylo.yml"], package: "@totto2727/reylo" }],
  include: ["main.ts", "config"],
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a project file in the mapper's extensions is a module that declares nothing, never a query", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "reylo-project-file-"));
  const root = await realpath(temp);
  await writeProjectFiles(root);
  await installProject(root);
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify(config));
  const result = await runChild(process.execPath, [TSC, "-p", "tsconfig.json", "--runExternalCode", "--pretty", "false"], { cwd: root });
  assert.equal(result.stdout + result.stderr, "");
  assert.equal(result.status, 0);
});
