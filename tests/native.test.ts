// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to await writes and reads through the host filesystem.
import { realpath, rm } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to use the host resolver for the installed driver or fixture package.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- The Nub integration fixtures use this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
import { nativeBinary, platformPackage, PLATFORM_PACKAGES } from "#reylo-source/native.ts";
import { hasFunctionType, isRecord, matchesUndefined } from "#reylo-source/native-predicates.ts";
import { executable, legacyInstallation, nativeTestDirectory, overrideEnginePath } from "./native-engine-fixture.ts";

const withoutOverride = async function (run: () => Promise<void> | void): Promise<void> {
  const restore = overrideEnginePath();
  try {
    await run();
  } finally {
    restore();
  }
};

const options = { force: true, recursive: true };

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the default native executable comes from the installed upstream platform package", async () => {
  await withoutOverride(async () => {
    const { pkg } = platformPackage();
    assert.ok(!matchesUndefined(pkg), "the maintained checks require a supported native platform");
    const require = createRequire(import.meta.url);
    const installed = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "bin", executable);
    assert.equal(await realpath(nativeBinary()), await realpath(installed));
  });
});

Iterator.from([["release"], ["debug"], ["release", "debug"]]).forEach((profiles) => {
  // oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
  test(`a missing upstream package is not masked by legacy ${profiles.join(" and ")} binaries`, async (testContext) => {
    // A separate install layout keeps this checkout's installed optional dependency out of resolution.
    const root = await nativeTestDirectory("reylo-native-install-");
    testContext.after(async () => {await rm(root, options);});
    const module = await legacyInstallation(root, profiles);
    const isolated: unknown = await import(module.href);
    assert.ok(isRecord(isolated) && hasFunctionType(isolated.nativeBinary));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The isolated fixture is a copy of this checkout’s native resolver.
    const resolve = isolated.nativeBinary as typeof nativeBinary;
    await withoutOverride(() => {
      const { key, pkg } = platformPackage();
      const why = matchesUndefined(pkg) ? `reylo ships no binary for ${key}` : `${pkg} is not installed (an install with --no-optional, or --omit=optional, leaves it out)`;
      assert.throws(() => resolve(), {
        message: `reylo's engine, the reylo executable, is missing: ${why}. Install reylo again with optional dependencies enabled on a supported platform (${Object.keys(PLATFORM_PACKAGES).join(", ")}), or set REYLO_ENGINE_PATH to a compatible reylo executable.`,
      });
    });
  });
});
