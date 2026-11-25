// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Run Vitest watch as a real subprocess and stop it at teardown.
import { spawn } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- A native watch test waits for its own child process to close.
import type { ChildProcess } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Build and read the fixture projects used by the test runners.
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Exercise the native SQLite driver used by Reylo's Node runtime.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to await the host timer used by the polling or subprocess fixture.
import { setTimeout as sleep } from "node:timers/promises";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to convert local module URLs with the host platform's path rules.
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
const runEnvironment = (nodeOptions = ""): NodeJS.ProcessEnv => ({
  // oxlint-disable-next-line node/no-process-env -- Real Jest and Vitest subprocesses inherit the test host's PATH and platform environment.
  ...process.env,
  NODE_OPTIONS: `--no-warnings ${nodeOptions}`,
  NO_COLOR: "1",
});

interface RunOptions {
  cwd?: string;
  nodeOptions?: string;
}

interface RunnerResult {
  output: string;
  status: number | null;
}

const run = async function (bin: string, args: string[], options: RunOptions = {}): Promise<RunnerResult> {
  const { cwd = lab, nodeOptions } = options;
  const result = await runChild(process.execPath, [`${lab}/node_modules/${bin}`, ...args], { cwd, env: runEnvironment(nodeOptions) });
  return { output: result.stdout + result.stderr, status: result.status };
};

const cache = await mkdtemp(path.join(tmpdir(), "reylo-jest-"));
const jest = async (args: string[], nodeOptions = ""): Promise<RunnerResult> => {
  const options = { nodeOptions };
  return run("jest/bin/jest.js", ["--ci", "--runInBand", `--cacheDirectory=${cache}`, ...args], options);
};

const VITEST = "vitest/vitest.mjs";
const SERIAL_VITEST = ["--maxWorkers=1", "--no-file-parallelism"];
const VITEST_RUN = ["run", ...SERIAL_VITEST];

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("setup", { skip }, async () => {
  const result = await runChild(process.execPath, ["setup.mjs"], { cwd: lab });
  assert.equal(result.status, 0);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Jest's runtime never asks Node's loader: the @totto2727/reylo/register preload leaves a .sql file to Jest, which reads it as JavaScript", { skip }, async () => {
  const result = await jest(["--config", JSON.stringify({ extensionsToTreatAsEsm: [".sql"], testPathIgnorePatterns: ["/node_modules/", "/probe/"], watchman: false })], "--experimental-vm-modules --import @totto2727/reylo/register");
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /SyntaxError: Unexpected identifier 'id'/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("@totto2727/reylo/jest: a CommonJS run, with reylo's runtime compiled to CommonJS by babel-jest", { skip }, async () => {
  const result = await jest(["-c", "jest.cjs.config.cjs", "query.test.cjs"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Tests:\s+1 passed, 1 total/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("@totto2727/reylo/jest: an ESM run (--experimental-vm-modules), a CommonJS and an ESM test", { skip }, async () => {
  const result = await jest(["-c", "jest.esm.config.cjs"], "--experimental-vm-modules");
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Tests:\s+2 passed, 2 total/u);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Vitest needs nothing beyond @totto2727/reylo/vite", { skip }, async () => {
  const result = await run(VITEST, VITEST_RUN);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Tests\s+1 passed/u);
});

// A project outside the repository on lab/jest's Vitest, with Vitest's module cache on (its default
// From 5.0.5; lab/jest's 5.0.3 has it off) and a statement a unique index changes from `many` to
// `maybeOne`. Each run of its test adds the cardinality its module carries to `seen.txt`.
interface CachedProject {
  dir: string;
  exec: (sql: string) => void;
  seen: () => Promise<string[]>;
}

const linkCachedRuntime = async function (dir: string): Promise<void> {
  await mkdir(`${dir}/node_modules/@totto2727`, { recursive: true });
  await symlink(`${lab}/node_modules/vitest`, `${dir}/node_modules/vitest`);
  await symlink(root, `${dir}/node_modules/@totto2727/reylo`);
  await symlink(`${root}/packages/sqlite`, `${dir}/node_modules/@totto2727/reylo-sqlite`);
};

const writeCachedInputs = async function (dir: string): Promise<void> {
  await writeFile(`${dir}/package.json`, `{ "private": true }\n`);
  await writeFile(`${dir}/.reylo.yaml`, "direct_url: file:./app.db\n");
  await writeFile(`${dir}/vitest.config.mjs`, `import reylo from "@totto2727/reylo/vite";\nexport default { plugins: [reylo()], test: { globals: true, fsModuleCache: true } };\n`);
  await writeFile(`${dir}/by-email.sql`, "select id, name from users where email = :email\n");
  await writeFile(`${dir}/by-email.test.mjs`, `import { appendFileSync } from "node:fs";\nimport query from "./by-email.sql";\ntest("by-email", () => appendFileSync(new URL("./seen.txt", import.meta.url), query.cardinality + "\\n"));\n`);
};

const readRuns = async function (dir: string): Promise<string[]> {
  const results = `${dir}/seen.txt`;
  if (!(await exists(results))) {return [];}
  const runs = await readFile(results, "utf8");
  return runs.trim().split("\n");
};

const runMigration = function (dir: string, sql: string): void {
  const database = new DatabaseSync(`${dir}/app.db`);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
};

const cachedProject = async function (): Promise<CachedProject> {
  const dir = await mkdtemp(path.join(tmpdir(), "reylo-vitest-"));
  await linkCachedRuntime(dir);
  await writeCachedInputs(dir);
  const exec = (sql: string): void => {runMigration(dir, sql);};
  exec("create table users (id integer primary key, name text not null, email text)");
  const seen = async (): Promise<string[]> => readRuns(dir);
  return { dir, exec, seen };
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Vitest's module cache makes a .sql module again after a migration", { skip }, async () => {
  const { dir, exec, seen } = await cachedProject();
  const vitest = async (): Promise<void> => {
    const result = await run(VITEST, VITEST_RUN, { cwd: dir });
    assert.equal(result.status, 0, result.output);
  };
  await vitest();
  exec("create unique index users_email on users(email)");
  await vitest();
  await vitest();
  assert.deepEqual(await seen(), ["many", "maybeOne", "maybeOne"]);
});

const generateQueryModules = async function (dir: string): Promise<void> {
  const result = await runChild(process.execPath, [`${root}/src/cli.ts`, "generate"], { cwd: dir, env: runEnvironment() });
  assert.equal(result.status, 0, result.stdout + result.stderr);
};

const RUN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

interface Watch {
  waitForRuns: (lines: number) => Promise<void>;
  stop: () => Promise<void>;
}

// oxlint-disable-next-line typescript/promise-function-async -- Install the close listener synchronously before the watcher can exit.
const waitForClose = function (child: ChildProcess): Promise<number | null> {
  const { promise, resolve } = Promise.withResolvers<number | null>();
  child.once("close", resolve);
  return promise;
};

const startVitestWatch = function (dir: string, seen: CachedProject["seen"]): Watch {
  const child = spawn(process.execPath, [`${lab}/node_modules/${VITEST}`, "--watch", ...SERIAL_VITEST], {
    cwd: dir,
    env: runEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  const record = (chunk: Buffer): void => {chunks.push(String(chunk));};
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.on("error", (error) => {chunks.push(error.message);});
  const closed = waitForClose(child);
  const stop = async (): Promise<void> => {
    child.kill();
    await closed;
  };
  const waitForRuns = async (lines: number): Promise<void> => {
    const deadline = performance.now() + RUN_TIMEOUT_MS;
    const poll = async (): Promise<void> => {
      const runs = await seen();
      if (runs.length >= lines) {return;}
      if (performance.now() > deadline) {
        assert.fail(`no run ${lines} of the test:\n${chunks.join("")}`);
      }
      await sleep(POLL_INTERVAL_MS);
      await poll();
    };
    await poll();
  };
  return { stop, waitForRuns };
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("Vitest's watch mode makes a .sql module again when the type check analyzes it anew", { skip }, async () => {
  const { dir, exec, seen } = await cachedProject();
  // Seed the analysis cache before Vitest starts. Regenerating after a migration must trigger its watch.
  await generateQueryModules(dir);
  const watch = startVitestWatch(dir, seen);
  try {
    await watch.waitForRuns(1);
    exec("create unique index users_email on users(email)");
    await generateQueryModules(dir);
    await watch.waitForRuns(2);
    assert.deepEqual(await seen(), ["many", "maybeOne"]);
  } finally {
    await watch.stop();
  }
});
