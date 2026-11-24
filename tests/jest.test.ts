// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Run Vitest watch as a real subprocess and stop it at teardown.
import { spawn } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Build and read the fixture projects used by the test runners.
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runChild } from "./helpers.ts";

// Jest and Vitest are lab/jest's dependencies, never the package's own.
const lab = fileURLToPath(new URL("../lab/jest", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};
const skip = !(await exists(`${lab}/node_modules/jest`)) && "lab/jest is not installed";

// NO_COLOR: Vitest colours its summary even into a pipe in some environments (one with no
// Variables but HOME and PATH, for one), and the assertions read the plain text.
const env = (nodeOptions = "") => ({ ...process.env, NO_COLOR: "1", NODE_OPTIONS: `--no-warnings ${nodeOptions}` });

const run = async function (bin: string, args: string[], nodeOptions = "", cwd = lab) {
  const result = await runChild(process.execPath, [`${lab}/node_modules/${bin}`, ...args], { cwd, env: env(nodeOptions) });
  return { status: result.status, output: result.stdout + result.stderr };
};

const cache = await mkdtemp(join(tmpdir(), "reylo-jest-"));
const jest = (args: string[], nodeOptions?: string) => run("jest/bin/jest.js", ["--ci", `--cacheDirectory=${cache}`, ...args], nodeOptions);

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("setup", { skip }, async () => {
  assert.equal((await runChild(process.execPath, ["setup.mjs"], { cwd: lab })).status, 0);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Jest's runtime never asks Node's loader: the @totto2727/reylo/register preload leaves a .sql file to Jest, which reads it as JavaScript", { skip }, async () => {
  const r = await jest(["--config", JSON.stringify({ watchman: false, testPathIgnorePatterns: ["/node_modules/", "/probe/"], extensionsToTreatAsEsm: [".sql"] })], "--experimental-vm-modules --import @totto2727/reylo/register");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /SyntaxError: Unexpected identifier 'id'/);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("@totto2727/reylo/jest: a CommonJS run, with reylo's runtime compiled to CommonJS by babel-jest", { skip }, async () => {
  const r = await jest(["-c", "jest.cjs.config.cjs", "query.test.cjs"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Tests:\s+1 passed, 1 total/);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("@totto2727/reylo/jest: an ESM run (--experimental-vm-modules), a CommonJS and an ESM test", { skip }, async () => {
  const r = await jest(["-c", "jest.esm.config.cjs"], "--experimental-vm-modules");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Tests:\s+2 passed, 2 total/);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Vitest needs nothing beyond @totto2727/reylo/vite", { skip }, async () => {
  const r = await run("vitest/vitest.mjs", ["run"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Tests\s+1 passed/);
});

// A project outside the repository on lab/jest's Vitest, with Vitest's module cache on (its default
// From 5.0.5; lab/jest's 5.0.3 has it off) and a statement a unique index changes from `many` to
// `maybeOne`. Each run of its test adds the cardinality its module carries to `seen.txt`.
const cachedProject = async function () {
  const dir = await mkdtemp(join(tmpdir(), "reylo-vitest-"));
  await mkdir(`${dir}/node_modules/@totto2727`, { recursive: true });
  await symlink(`${lab}/node_modules/vitest`, `${dir}/node_modules/vitest`);
  await symlink(root, `${dir}/node_modules/@totto2727/reylo`);
  await symlink(`${root}/packages/sqlite`, `${dir}/node_modules/@totto2727/reylo-sqlite`);
  await writeFile(`${dir}/package.json`, `{ "private": true }\n`);
  await writeFile(`${dir}/.reylo.yaml`, "direct_url: file:./app.db\n");
  await writeFile(`${dir}/vitest.config.mjs`, `import reylo from "@totto2727/reylo/vite";\nexport default { plugins: [reylo()], test: { globals: true, fsModuleCache: true } };\n`);
  await writeFile(`${dir}/by-email.sql`, "select id, name from users where email = :email\n");
  await writeFile(`${dir}/by-email.test.mjs`, `import { appendFileSync } from "node:fs";\nimport query from "./by-email.sql";\ntest("by-email", () => appendFileSync(new URL("./seen.txt", import.meta.url), query.cardinality + "\\n"));\n`);
  const exec = (sql: string) => {
    const db = new DatabaseSync(`${dir}/app.db`);
    db.exec(sql);
    db.close();
  };
  exec("create table users (id integer primary key, name text not null, email text)");
  const seen = async (): Promise<string[]> => {
    const results = `${dir}/seen.txt`;
    return (await exists(results)) ? (await readFile(results, "utf8")).trim().split("\n") : [];
  };
  return { dir, exec, seen };
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Vitest's module cache makes a .sql module again after a migration", { skip }, async () => {
  const { dir, exec, seen } = await cachedProject();
  const vitest = async () => {
    const r = await run("vitest/vitest.mjs", ["run"], "", dir);
    assert.equal(r.status, 0, r.output);
  };
  await vitest();
  exec("create unique index users_email on users(email)");
  await vitest();
  await vitest();
  assert.deepEqual(await seen(), ["many", "maybeOne", "maybeOne"]);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Vitest's watch mode makes a .sql module again when the type check analyzes it anew", { skip }, async () => {
  const { dir, exec, seen } = await cachedProject();
  // The type check (here `reylo generate`) writes the statement's entry to `.reylo/`, which the
  // Module is built from; it is there before Vitest starts, so that its first run writes none.
  const generate = async () => {
    const r = await runChild(process.execPath, [`${root}/src/cli.ts`, "generate"], { cwd: dir, env: env() });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  };
  await generate();
  const watch = spawn(process.execPath, [`${lab}/node_modules/vitest/vitest.mjs`, "--watch"], { cwd: dir, env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  watch.stdout.on("data", (chunk) => (output += chunk));
  watch.stderr.on("data", (chunk) => (output += chunk));
  const until = async (lines: number) => {
    for (const deadline = Date.now() + 30_000; (await seen()).length < lines; await sleep(100)) {if (Date.now() > deadline) {assert.fail(`no run ${lines} of the test:\n${output}`);}}
  };
  try {
    await until(1);
    exec("create unique index users_email on users(email)");
    await generate();
    await until(2);
    assert.deepEqual(await seen(), ["many", "maybeOne"]);
  } finally {
    watch.kill();
  }
});
