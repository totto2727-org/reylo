// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to await writes and reads through the host filesystem.
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
import { withReylo } from "#reylo-source/next.ts";
import { promiseDriverStub, requireFixtureValue } from "./helpers.ts";

// `next build` type-checks with the project's own tsc and no --runExternalCode, so withReylo turns
// That check off and runs it with the flag in compiler.runAfterProductionCompile (src/next.ts).
const REPO = path.join(import.meta.dirname, "..");

interface Built {
  typescript?: { ignoreBuildErrors?: boolean; tsconfigPath?: string };
  compiler?: { runAfterProductionCompile?: (metadata: { projectDir: string; distDir: string }) => Promise<void> };
}
type AfterCompile = NonNullable<NonNullable<Built["compiler"]>["runAfterProductionCompile"]>;

const afterCompile = (config: Built): AfterCompile =>
  requireFixtureValue(withReylo(config).compiler?.runAfterProductionCompile);

interface WebpackFixture { module: { rules: unknown[] } }
type WebpackHook = (config: WebpackFixture, context: { isServer: boolean }) => WebpackFixture;

const assertWebpackLoader = (config: { webpack: WebpackHook }): void => {
  const server = config.webpack({ module: { rules: [] } }, { isServer: true });
  assert.deepEqual(server.module.rules, [{ test: /\.sql$/u, use: "@totto2727/reylo/webpack" }]);
  const client = config.webpack({ module: { rules: [] } }, { isServer: false });
  assert.deepEqual(client.module.rules, []);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("withReylo adds the loader on the server for Turbopack and webpack, and keeps the project's config", () => {
  const seen: string[] = [];
  const config = withReylo({
    reactStrictMode: true,
    turbopack: { root: "/app", rules: { "*.md": { as: "*.js", loaders: ["md-loader"] } } },
    webpack(webpackConfig: { module: { rules: unknown[] } }, context: { isServer: boolean }) {
      seen.push(context.isServer ? "server" : "client");
      return webpackConfig;
    },
  });
  assert.equal(config.reactStrictMode, true);
  assert.equal(config.turbopack.root, "/app");
  assert.deepEqual(config.turbopack.rules, {
    "*.md": { as: "*.js", loaders: ["md-loader"] },
    "*.sql": { as: "*.js", condition: { not: "browser" }, loaders: ["@totto2727/reylo/turbopack"] },
  });
  assertWebpackLoader(config);
  assert.deepEqual(seen, ["server", "client"]);
  // A rule of the project's own for *.sql wins.
  const own = withReylo({ turbopack: { rules: { "*.sql": { loaders: ["own"] } } } });
  assert.deepEqual(own.turbopack.rules["*.sql"], { loaders: ["own"] });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("withReylo takes a config of Next's own keys written in place, beside the ones it reads", () => {
  // A type check: each key here is one withReylo's own type does not name.
  const config = withReylo({ compiler: { removeConsole: true }, reactStrictMode: true, turbopack: { root: "/app" }, typescript: { tsconfigPath: "tsconfig.json" } });
  assert.equal(config.reactStrictMode, true);
  assert.equal(config.turbopack.root, "/app");
  assert.equal(config.compiler.removeConsole, true);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("withReylo turns Next's type check off for its own, and leaves both off where the project turned Next's off", () => {
  const config: Built = withReylo({ typescript: { tsconfigPath: "tsconfig.app.json" } });
  assert.deepEqual(config.typescript, { ignoreBuildErrors: true, tsconfigPath: "tsconfig.app.json" });
  assert.equal(typeof config.compiler?.runAfterProductionCompile, "function");
  const off: Built = withReylo({ typescript: { ignoreBuildErrors: true } });
  assert.deepEqual(off.typescript, { ignoreBuildErrors: true });
  assert.equal(off.compiler, undefined);
});

const compilerOptions = {
  allowImportingTsExtensions: true, module: "nodenext", noEmit: true, skipLibCheck: true,
  strict: true, target: "esnext", types: [],
};

const nextProject = async (root: string): Promise<void> => {
  await writeFile(path.join(root, "package.json"), '{ "private": true, "type": "module" }');
  await writeFile(path.join(root, ".env"), "DATABASE_URL=file:./app.db\n");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions,
    contentMappers: [{ extensions: [".sql"], package: "@totto2727/reylo" }],
    include: ["*.ts"],
  }));
  const scope = path.join(root, "node_modules", "@totto2727");
  await mkdir(scope, { recursive: true });
  await symlink(REPO, path.join(scope, "reylo"));
  await symlink(path.join(REPO, "node_modules", "typescript"), path.join(root, "node_modules", "typescript"));
};

const database = (root: string): void => {
  const connection = new DatabaseSync(path.join(root, "app.db"));
  try {
    connection.exec("create table users (id integer primary key, name text not null)");
  } finally {
    connection.close();
  }
};

const app = async (main: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "reylo-next-"));
  await nextProject(root);
  database(root);
  await writeFile(path.join(root, "get_user.sql"), "select id, name from users where id = :id\n");
  await writeFile(path.join(root, "main.ts"), main);
  await writeFile(path.join(root, "next-env.d.ts"), "");
  return root;
};

const metadata = (projectDir: string): { distDir: string; projectDir: string } =>
  ({ distDir: path.join(projectDir, ".next"), projectDir });

const quiet = (): void => {
  // The native mock context retains console arguments while keeping this test output clean.
};

const ROW = `import getUser from "./get_user.sql";\ntype User = NonNullable<Awaited<ReturnType<typeof getUser.run>>>;\n`;

const assertTypeFailure = async (hook: AfterCompile): Promise<void> => {
  const bad = await app(`${ROW}export const id: User["id"] = "one";\n`);
  await assert.rejects(hook(metadata(bad)), /Failed to type check/u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the type check runs the content mapper after the project's own hook, and fails on an error at its line and column", async (testContext) => {
  const printed = testContext.mock.method(console, "log", quiet);
  const order: string[] = [];
  const hook = afterCompile({
    compiler: {
      runAfterProductionCompile: promiseDriverStub(() => {order.push("project");}),
    },
  });

  // Without --runExternalCode, `User` would be an error: the .sql import is TS2307.
  const good = await app(`${ROW}export const name: User["name"] = "ada";\n`);
  await hook(metadata(good));
  assert.deepEqual(order, ["project"]);
  assert.equal(printed.mock.callCount(), 0);

  await assertTypeFailure(hook);
  const output = printed.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  assert.match(output, /main\.ts\(3,14\): error TS2322: Type 'string' is not assignable to type 'number'\./u);
});

const setupTypegen = async (root: string): Promise<void> => {
  const next = path.join(root, "node_modules", "next");
  await mkdir(path.join(next, "dist", "bin"), { recursive: true });
  await writeFile(path.join(next, "package.json"), JSON.stringify({ bin: { next: "./dist/bin/next" }, name: "next" }));
  await writeFile(
    path.join(next, "dist", "bin", "next"),
    `require("node:fs").writeFileSync(require("node:path").join(process.argv[3], "next-env.d.ts"), "// " + process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  await rm(path.join(root, "next-env.d.ts"));
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("on a first build the type check runs next typegen, which writes next-env.d.ts", async (testContext) => {
  testContext.mock.method(console, "log", quiet);
  const root = await app(`${ROW}export const name: User["name"] = "ada";\n`);
  await setupTypegen(root);
  await afterCompile({})(metadata(root));
  assert.equal(await readFile(path.join(root, "next-env.d.ts"), "utf8"), `// typegen ${root}\n`);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the type check refuses a TypeScript older than 7.1, which has no content mappers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reylo-next-"));
  await writeFile(path.join(root, "package.json"), "{}");
  await mkdir(path.join(root, "node_modules", "typescript"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "typescript", "package.json"), `{ "name": "typescript", "version": "6.0.3" }`);
  await assert.rejects(
    afterCompile({})(metadata(root)),
    /needs TypeScript 7\.1 or later, whose content mappers type \.sql imports; the project has TypeScript 6\.0\.3/u,
  );
  await assert.rejects(access(path.join(root, "next-env.d.ts")), { code: "ENOENT" });
});
