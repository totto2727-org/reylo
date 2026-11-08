import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyEngine, engine, MissingEngine, Unreachable } from "../src/engine.ts";
import { nativeBinary, PLATFORM_PACKAGES, platformPackage } from "../src/native.ts";
import { resolveProject } from "../src/project.ts";
import { ENGINE_VERSION } from "../src/engine-version.ts";

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const noShell = process.platform === "win32" && "stand-in executables require a POSIX shell";

/** Isolate the executable override and remove the stand-in after its child has stopped. */
async function withEngine<T>(body: string, run: (path: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "reylo-native-test-"));
  const path = join(root, "reylo");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  const before = process.env.REYLO_ENGINE_PATH;
  process.env.REYLO_ENGINE_PATH = path;
  try {
    return await run(path);
  } finally {
    if (before === undefined) delete process.env.REYLO_ENGINE_PATH;
    else process.env.REYLO_ENGINE_PATH = before;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Answer the first request, which always has id 1, then exit. */
function ping(version: string = ENGINE_VERSION, database = "sqlite"): string {
  return `read -r line\nprintf '%s\\n' '${JSON.stringify({ status: "ok", version, database, fingerprint: "0123456789abcdef", id: 1 })}'`;
}

test("native packages cover supported platforms at the exact upstream engine version", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(PLATFORM_PACKAGES).length, 8);
  for (const [key, pkg] of Object.entries(PLATFORM_PACKAGES)) {
    assert.equal(pkg, `@reylosql/engine-${key}`);
    assert.equal(manifest.optionalDependencies[pkg], ENGINE_VERSION);
  }
  const { key, pkg } = platformPackage();
  assert.equal(pkg, PLATFORM_PACKAGES[key]);
  assert.match(key, /^(darwin|linux|win32)-(arm64|x64)(-musl)?$/);
});

test("REYLO_ENGINE_PATH takes precedence and a missing override is actionable", { skip: noShell }, async () => {
  await withEngine(ping(), async (path) => {
    assert.equal(nativeBinary(), path);
    rmSync(path);
    assert.throws(() => nativeBinary(), { message: `REYLO_ENGINE_PATH names ${path}, which does not exist: point it at a reylo executable, or unset it to use the one reylo installs` });
    await assert.rejects(engine("sqlite"), (e: Error) => e instanceof MissingEngine && e.message.startsWith("REYLO_ENGINE_PATH names"));
    const reader = await anyEngine();
    assert.ok(reader instanceof MissingEngine);
    const root = join(path, "..");
    writeFileSync(join(root, ".reylo.yaml"), "direct_url: file:./app.db\n");
    assert.match(resolveProject(reader, root, {}).error!, /^\.reylo\.yaml: REYLO_ENGINE_PATH names /);
  });
});

test("unsupported dialects never start the native executable", async () => {
  for (const dialect of ["postgres", "mysql", "duckdb"] as const) {
    await assert.rejects(engine(dialect), {
      name: "MissingEngine",
      message: `This fork supports SQLite analysis only, not ${dialect} statements`,
    });
  }
});

test("a mismatched native version is refused and a failed load can be retried", { skip: noShell }, async () => {
  await withEngine(ping("9.9.9"), async (path) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(engine("sqlite"), (e: Error) => {
        assert.ok(e instanceof MissingEngine);
        assert.equal(e.message, `reylo ${VERSION} runs with its engine at ${ENGINE_VERSION}, and ${path} is 9.9.9: install reylo again with optional dependencies enabled, or point REYLO_ENGINE_PATH at the engine of reylo ${ENGINE_VERSION}`);
        return true;
      });
    }
    writeFileSync(path, `#!/bin/sh\n${ping(ENGINE_VERSION, "postgres")}\n`);
    await assert.rejects(engine("sqlite"), { message: `${path} serves postgres's engine when asked for sqlite's` });
  });
});

test("a fork patch version does not replace the required upstream native release", { skip: noShell }, async () => {
  const mismatched = VERSION === ENGINE_VERSION ? "9.9.9" : VERSION;
  await withEngine(ping(mismatched), (path) =>
    assert.rejects(engine("sqlite"), (error: Error) =>
      error instanceof MissingEngine && error.message.includes(`runs with its engine at ${ENGINE_VERSION}, and ${path} is ${mismatched}`),
    ),
  );
});

test("an executable that exits or never answers is refused", { skip: noShell }, async () => {
  await withEngine("echo 'no such thing' >&2\nexit 3", (path) =>
    assert.rejects(engine("sqlite"), { message: `the engine ${path} does not answer: the engine ${path} stopped (3): no such thing` }),
  );
  await withEngine("exec sleep 60", (path) =>
    assert.rejects(engine("sqlite"), { message: `the engine ${path} does not answer: it did not answer a ping in 10 s` }),
  );
});

test("the installed SQLite engine reads project configuration and is reused", async (t) => {
  const e = await engine("sqlite");
  assert.equal(await engine("sqlite"), e);
  assert.equal(await anyEngine(), e);
  const root = mkdtempSync(join(tmpdir(), "reylo-native-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".reylo.yaml"), "direct_url: file:./app.db\n");
  const resolved = resolveProject(e, root, {});
  assert.deepEqual([resolved.dialect, resolved.error], ["sqlite", undefined]);
});

test("a closed SQLite connection is refused and a new connection works", async () => {
  const e = await engine("sqlite");
  const c = await e.open(":memory:");
  try {
    assert.deepEqual((await c.analyze("select 1 as x")).columns.map((col) => col.name), ["x"]);
  } finally {
    await c.close();
  }
  await assert.rejects(c.analyze("select 1"), (err: Error) => err instanceof Unreachable && err.message === "the connection is closed");
  const again = await e.open(":memory:");
  try {
    assert.deepEqual(await again.query("select ? as y", [2]), [[2]]);
  } finally {
    await again.close();
  }
});
