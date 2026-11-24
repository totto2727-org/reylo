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
import { join } from "node:path";
import { withReylo } from "#reylo-source/next.ts";

// `next build` type-checks with the project's own tsc and no --runExternalCode, so withReylo turns
// That check off and runs it with the flag in compiler.runAfterProductionCompile (src/next.ts).
const REPO = join(import.meta.dirname, "..");

type Built = {
  typescript?: { ignoreBuildErrors?: boolean; tsconfigPath?: string };
  compiler?: { runAfterProductionCompile?: (metadata: { projectDir: string; distDir: string }) => Promise<void> };
};
/** The hook withReylo leaves in the config it returns, which next build runs after the compile. */
const afterCompile = (config: Built) => (withReylo(config) as Built).compiler!.runAfterProductionCompile!;

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("withReylo adds the loader on the server for Turbopack and webpack, and keeps the project's config", () => {
  const seen: string[] = [];
  const config = withReylo({
    reactStrictMode: true,
    turbopack: { root: "/app", rules: { "*.md": { loaders: ["md-loader"], as: "*.js" } } },
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
  const server = config.webpack({ module: { rules: [] } }, { isServer: true });
  assert.deepEqual(server.module.rules, [{ test: /\.sql$/u, use: "@totto2727/reylo/webpack" }]);
  const client = config.webpack({ module: { rules: [] } }, { isServer: false });
  assert.deepEqual(client.module.rules, []);
  assert.deepEqual(seen, ["server", "client"]);
  // A rule of the project's own for *.sql wins.
  const own = withReylo({ turbopack: { rules: { "*.sql": { loaders: ["own"] } } } });
  assert.deepEqual(own.turbopack.rules["*.sql"], { loaders: ["own"] });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("withReylo takes a config of Next's own keys written in place, beside the ones it reads", () => {
  // A type check: each key here is one withReylo's own type does not name.
  const config = withReylo({ reactStrictMode: true, turbopack: { root: "/app" }, typescript: { tsconfigPath: "tsconfig.json" }, compiler: { removeConsole: true } });
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

/**
 * Prepare a Next.js app with a SQLite query and this repository's TypeScript.
 * @param {string} main - Source for the app's entry file.
 * @returns {Promise<string>} The prepared project directory.
 */
const app = async function (main: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reylo-next-"));
  await writeFile(join(root, "package.json"), `{ "private": true, "type": "module" }`);
  await writeFile(join(root, ".env"), "DATABASE_URL=file:./app.db\n");
  const db = new DatabaseSync(join(root, "app.db"));
  db.exec("create table users (id integer primary key, name text not null)");
  db.close();
  await writeFile(join(root, "get_user.sql"), "select id, name from users where id = :id\n");
  await writeFile(join(root, "main.ts"), main);
  await writeFile(join(root, "next-env.d.ts"), "");
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "esnext", module: "nodenext", types: [], strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true },
      contentMappers: [{ package: "@totto2727/reylo", extensions: [".sql"] }],
      include: ["*.ts"],
    }),
  );
  await mkdir(join(root, "node_modules", "@totto2727"), { recursive: true });
  await symlink(REPO, join(root, "node_modules", "@totto2727/reylo"));
  await symlink(join(REPO, "node_modules", "typescript"), join(root, "node_modules", "typescript"));
  return root;
};

const ROW = `import getUser from "./get_user.sql";\ntype User = NonNullable<Awaited<ReturnType<typeof getUser.run>>>;\n`;

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the type check runs the content mapper after the project's own hook, and fails on an error at its line and column", async (testContext) => {
  const printed = testContext.mock.method(console, "log", () => {});
  const order: string[] = [];
  const hook = afterCompile({
    compiler: {
      async runAfterProductionCompile() {
        order.push("project");
      },
    },
  });

  // Without --runExternalCode, `User` would be an error: the .sql import is TS2307.
  const good = await app(`${ROW}export const name: User["name"] = "ada";\n`);
  await hook({ projectDir: good, distDir: join(good, ".next") });
  assert.deepEqual(order, ["project"]);
  assert.equal(printed.mock.callCount(), 0);

  const bad = await app(`${ROW}export const id: User["id"] = "one";\n`);
  await assert.rejects(hook({ projectDir: bad, distDir: join(bad, ".next") }), /Failed to type check/u);
  const output = printed.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  assert.match(output, /main\.ts\(3,14\): error TS2322: Type 'string' is not assignable to type 'number'\./u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("on a first build the type check runs next typegen, which writes next-env.d.ts", async (testContext) => {
  testContext.mock.method(console, "log", () => {});
  const root = await app(`${ROW}export const name: User["name"] = "ada";\n`);
  const next = join(root, "node_modules", "next");
  await mkdir(join(next, "dist", "bin"), { recursive: true });
  await writeFile(join(next, "package.json"), JSON.stringify({ name: "next", bin: { next: "./dist/bin/next" } }));
  await writeFile(
    join(next, "dist", "bin", "next"),
    `require("node:fs").writeFileSync(require("node:path").join(process.argv[3], "next-env.d.ts"), "// " + process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  await rm(join(root, "next-env.d.ts"));
  await afterCompile({})({ projectDir: root, distDir: join(root, ".next") });
  assert.equal(await readFile(join(root, "next-env.d.ts"), "utf8"), `// typegen ${root}\n`);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the type check refuses a TypeScript older than 7.1, which has no content mappers", async () => {
  const root = await mkdtemp(join(tmpdir(), "reylo-next-"));
  await writeFile(join(root, "package.json"), "{}");
  await mkdir(join(root, "node_modules", "typescript"), { recursive: true });
  await writeFile(join(root, "node_modules", "typescript", "package.json"), `{ "name": "typescript", "version": "6.0.3" }`);
  await assert.rejects(
    afterCompile({})({ projectDir: root, distDir: join(root, ".next") }),
    /needs TypeScript 7\.1 or later, whose content mappers type \.sql imports; the project has TypeScript 6\.0\.3/u,
  );
  await assert.rejects(access(join(root, "next-env.d.ts")), { code: "ENOENT" });
});
