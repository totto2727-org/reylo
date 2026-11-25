// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to await writes and reads through the host filesystem.
import { readFile, rm, writeFile } from "node:fs/promises";
import { anyEngine, engine, MissingEngine, Unreachable } from "#reylo-source/engine.ts";
import { nativeBinary, PLATFORM_PACKAGES, platformPackage } from "#reylo-source/native.ts";
import { resolveProject } from "#reylo-source/project.ts";
import { ENGINE_VERSION } from "#reylo-source/engine-version.ts";
import { isRecord, matchesString } from "#reylo-source/native-predicates.ts";
import { forEachFixtureInOrder } from "./helpers.ts";
import { configureProjectFile, nativeTestDirectory, withEngine } from "./native-engine-fixture.ts";

const manifest: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.ok(isRecord(manifest) && matchesString(manifest.version) && isRecord(manifest.optionalDependencies));
const { optionalDependencies, version: VERSION } = manifest;
const noShell = process.platform === "win32" && "stand-in executables require a POSIX shell";

// Answer the first request, which always has id 1, then exit.
const ping = function (version: string = ENGINE_VERSION, database = "sqlite"): string {
  return `read -r line\nprintf '%s\\n' '${JSON.stringify({ database, fingerprint: "0123456789abcdef", id: 1, status: "ok", version })}'`;
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("native packages cover supported platforms at the exact upstream engine version", () => {
  assert.equal(Object.keys(PLATFORM_PACKAGES).length, 8);
  Object.entries(PLATFORM_PACKAGES).forEach(([key, pkg]) => {
    assert.equal(pkg, `@reylosql/engine-${key}`);
    assert.equal(optionalDependencies[pkg], ENGINE_VERSION);
  });
  const { key, pkg } = platformPackage();
  assert.equal(pkg, PLATFORM_PACKAGES[key]);
  assert.match(key, /^(?:darwin|linux|win32)-(?:arm64|x64)(?:-musl)?$/u);
});

const assertConfigurationError = async (reader: MissingEngine, root: string): Promise<void> => {
  await configureProjectFile(root);
  const { error } = resolveProject(reader, root, {});
  assert.ok(matchesString(error));
  assert.match(error, /^\.reylo\.yaml: REYLO_ENGINE_PATH names /u);
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("REYLO_ENGINE_PATH takes precedence and a missing override is actionable", { skip: noShell }, async () => {
  await withEngine(ping(), async (filename, root) => {
    assert.equal(nativeBinary(), filename);
    await rm(filename);
    assert.throws(() => nativeBinary(), { message: `REYLO_ENGINE_PATH names ${filename}, which does not exist: point it at a reylo executable, or unset it to use the one reylo installs` });
    await assert.rejects(engine("sqlite"), (error: Error) => error instanceof MissingEngine && error.message.startsWith("REYLO_ENGINE_PATH names"));
    const reader = await anyEngine();
    assert.ok(reader instanceof MissingEngine);
    await assertConfigurationError(reader, root);
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("unsupported dialects never start the native executable", async () => {
  await forEachFixtureInOrder(["postgres", "mysql", "duckdb"] as const, async (dialect) => {
    await assert.rejects(engine(dialect), {
      message: `This fork supports SQLite analysis only, not ${dialect} statements`,
      name: "MissingEngine",
    });
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a mismatched native version is refused and a failed load can be retried", { skip: noShell }, async () => {
  await withEngine(ping("9.9.9"), async (filename) => {
    await forEachFixtureInOrder(["first load", "retry"], async () => {
      await assert.rejects(engine("sqlite"), (error: Error) => {
        assert.ok(error instanceof MissingEngine);
        assert.equal(error.message, `reylo ${VERSION} runs with its engine at ${ENGINE_VERSION}, and ${filename} is 9.9.9: install reylo again with optional dependencies enabled, or point REYLO_ENGINE_PATH at the engine of reylo ${ENGINE_VERSION}`);
        return true;
      });
    });
    await writeFile(filename, `#!/bin/sh\n${ping(ENGINE_VERSION, "postgres")}\n`);
    await assert.rejects(engine("sqlite"), { message: `${filename} serves postgres's engine when asked for sqlite's` });
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a fork patch version does not replace the required upstream native release", { skip: noShell }, async () => {
  const mismatched = VERSION === ENGINE_VERSION ? "9.9.9" : VERSION;
  await withEngine(ping(mismatched), async (filename) => {
    await assert.rejects(engine("sqlite"), (error: Error) =>
      error instanceof MissingEngine && error.message.includes(`runs with its engine at ${ENGINE_VERSION}, and ${filename} is ${mismatched}`),
    );
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("an executable that exits or never answers is refused", { skip: noShell }, async () => {
  await withEngine("echo 'no such thing' >&2\nexit 3", async (filename) => {
    await assert.rejects(engine("sqlite"), { message: `the engine ${filename} does not answer: the engine ${filename} stopped (3): no such thing` });
  });
  await withEngine("exec sleep 60", async (filename) => {
    await assert.rejects(engine("sqlite"), { message: `the engine ${filename} does not answer: it did not answer a ping in 10 s` });
  });
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the installed SQLite engine reads project configuration and is reused", async (testContext) => {
  const currentEngine = await engine("sqlite");
  assert.equal(await engine("sqlite"), currentEngine);
  assert.equal(await anyEngine(), currentEngine);
  const root = await nativeTestDirectory("reylo-native-project-");
  testContext.after(async () => {await rm(root, { force: true, recursive: true });});
  await configureProjectFile(root);
  const resolved = resolveProject(currentEngine, root, {});
  assert.deepEqual([resolved.dialect, resolved.error], ["sqlite", undefined]);
});

const assertReopened = async (currentEngine: Awaited<ReturnType<typeof engine>>): Promise<void> => {
  const again = await currentEngine.open(":memory:");
  try {
    assert.deepEqual(await again.query("select ? as y", [2]), [[2]]);
  } finally {
    await again.close();
  }
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a closed SQLite connection is refused and a new connection works", async () => {
  const currentEngine = await engine("sqlite");
  const connection = await currentEngine.open(":memory:");
  try {
    const analysis = await connection.analyze("select 1 as x");
    assert.deepEqual(analysis.columns.map((column) => column.name), ["x"]);
  } finally {
    await connection.close();
  }
  await assert.rejects(connection.analyze("select 1"), (err: Error) => err instanceof Unreachable && err.message === "the connection is closed");
  await assertReopened(currentEngine);
});
