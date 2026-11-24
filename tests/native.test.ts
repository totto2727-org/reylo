// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to inspect or write files through the host filesystem.
import { realpathSync, rmSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to await writes and reads through the host filesystem.
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to use the host resolver for the installed driver or fixture package.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to select the host's real temporary directory.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import { dirname, join } from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to convert local module URLs with the host platform's path rules.
import { pathToFileURL } from "node:url";
import { nativeBinary, platformPackage, PLATFORM_PACKAGES } from "#reylo-source/native.ts";
import { matchesUndefined } from "#reylo-source/native-predicates.ts";

const withoutOverride = function (run: () => void): void {
  const before = process.env.REYLO_ENGINE_PATH;
  delete process.env.REYLO_ENGINE_PATH;
  try {
    run();
  } finally {
    if (matchesUndefined(before)) {delete process.env.REYLO_ENGINE_PATH;}
    else {process.env.REYLO_ENGINE_PATH = before;}
  }
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the default native executable comes from the installed upstream platform package", () => {
  withoutOverride(() => {
    const { pkg } = platformPackage();
    assert.ok(pkg, "the maintained checks require a supported native platform");
    const require = createRequire(import.meta.url);
    const exe = process.platform === "win32" ? "reylo.exe" : "reylo";
    const installed = join(dirname(require.resolve(`${pkg}/package.json`)), "bin", exe);
    assert.equal(realpathSync(nativeBinary()), realpathSync(installed));
  });
});

Iterator.from([["release"], ["debug"], ["release", "debug"]]).forEach((profiles) => {
  // oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
  test(`a missing upstream package is not masked by legacy ${profiles.join(" and ")} binaries`, async (testContext) => {
    // A separate install layout keeps the repository's real optional dependency out of resolution.
    const root = await mkdtemp(join(tmpdir(), "reylo-native-install-"));
    testContext.after(() => rmSync(root, { force: true, recursive: true }));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    const module = join(root, "src", "native.ts");
    await copyFile(new URL("../src/native.ts", import.meta.url), module);
    const exe = process.platform === "win32" ? "reylo.exe" : "reylo";
    for (const profile of profiles) {
      await mkdir(join(root, "target", profile), { recursive: true });
      await writeFile(join(root, "target", profile, exe), "legacy local build");
    }
    const isolated: typeof import("#reylo-source/native.ts") = await import(pathToFileURL(module).href);
    withoutOverride(() => {
      const { key, pkg } = platformPackage();
      const why = pkg ? `${pkg} is not installed (an install with --no-optional, or --omit=optional, leaves it out)` : `reylo ships no binary for ${key}`;
      assert.throws(() => isolated.nativeBinary(), {
        message: `reylo's engine, the reylo executable, is missing: ${why}. Install reylo again with optional dependencies enabled on a supported platform (${Object.keys(PLATFORM_PACKAGES).join(", ")}), or set REYLO_ENGINE_PATH to a compatible reylo executable.`,
      });
    });
  });
});
