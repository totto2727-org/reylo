import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeBinary, platformPackage, PLATFORM_PACKAGES } from "../src/native.ts";

function withoutOverride(run: () => void): void {
  const before = process.env.REYLO_ENGINE_PATH;
  delete process.env.REYLO_ENGINE_PATH;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.REYLO_ENGINE_PATH;
    else process.env.REYLO_ENGINE_PATH = before;
  }
}

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

for (const profiles of [["release"], ["debug"], ["release", "debug"]]) {
  test(`a missing upstream package is not masked by legacy ${profiles.join(" and ")} binaries`, async (t) => {
    // A separate install layout keeps the repository's real optional dependency out of resolution.
    const root = mkdtempSync(join(tmpdir(), "reylo-native-install-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    const module = join(root, "src", "native.ts");
    copyFileSync(new URL("../src/native.ts", import.meta.url), module);
    const exe = process.platform === "win32" ? "reylo.exe" : "reylo";
    for (const profile of profiles) {
      mkdirSync(join(root, "target", profile), { recursive: true });
      writeFileSync(join(root, "target", profile, exe), "legacy local build");
    }
    const isolated: typeof import("../src/native.ts") = await import(pathToFileURL(module).href);
    withoutOverride(() => {
      const { key, pkg } = platformPackage();
      const why = pkg ? `${pkg} is not installed (an install with --no-optional, or --omit=optional, leaves it out)` : `reylo ships no binary for ${key}`;
      assert.throws(() => isolated.nativeBinary(), {
        message: `reylo's engine, the reylo executable, is missing: ${why}. Install reylo again with optional dependencies enabled on a supported platform (${Object.keys(PLATFORM_PACKAGES).join(", ")}), or set REYLO_ENGINE_PATH to a compatible reylo executable.`,
      });
    });
  });
}
