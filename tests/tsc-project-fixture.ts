// oxlint-disable-next-line rules/no-node-imports -- Set up an actual project that resolves the scoped packages and its SQL content mapper.
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Temporary installs and TypeScript paths follow the host platform.
import path from "node:path";
import { forEachFixtureInOrder, ROOT, runChild } from "./helpers.ts";
import { withProject } from "./sqlite-project-fixture.ts";

// Windows cannot execute a POSIX shell shim from node_modules/.bin.
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const REYLO = "@totto2727/reylo";

const installMapper = async (root: string): Promise<void> => {
  const scope = path.join(root, "node_modules", "@totto2727");
  await mkdir(scope, { recursive: true });
  await symlink(ROOT, path.join(scope, "reylo"));
  await symlink(path.join(ROOT, "packages", "sqlite"), path.join(scope, "reylo-sqlite"));
};

const configureCompiler = async (root: string, noUnusedLocals: boolean): Promise<void> => {
  const compilerOptions = {
    allowImportingTsExtensions: true,
    lib: ["esnext"],
    module: "nodenext",
    noEmit: true,
    noUnusedLocals,
    skipLibCheck: true,
    strict: true,
    target: "esnext",
    types: [],
  };
  const contentMappers = [{ extensions: [".sql"], package: REYLO }];
  await writeFile(path.join(root, "package.json"), '{ "type": "module" }');
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions, contentMappers, include: ["main.ts"] }));
};

interface CompilerFixture {
  noUnusedLocals?: boolean;
  schema?: string;
}

export const withCompilerProject = async (
  { noUnusedLocals = false, schema = "" }: CompilerFixture,
  check: (root: string) => Promise<void>,
): Promise<void> => {
  await withProject(schema, async ({ database, root }) => {
    database.close();
    const project = await realpath(root);
    await installMapper(project);
    await configureCompiler(project, noUnusedLocals);
    await check(project);
  });
};

export const writeSql = async (root: string, files: Record<string, string>): Promise<void> => {
  await forEachFixtureInOrder(Object.entries(files), async ([name, text]) => {
    await writeFile(path.join(root, name), text);
  });
};

export const writeTypeScript = async (root: string, text: string): Promise<void> => {
  await writeFile(path.join(root, "main.ts"), text);
};

export const typeCheck = async (root: string, options: { env?: NodeJS.ProcessEnv } = {}): ReturnType<typeof runChild> =>
  runChild(process.execPath, [TSC, "-p", "tsconfig.json", "--runExternalCode", "--pretty", "false"], { ...options, cwd: root });
