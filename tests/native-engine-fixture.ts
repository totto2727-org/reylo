// oxlint-disable-next-line rules/no-node-imports -- Build real standalone resolution fixtures in temporary directories.
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Keep fixtures outside the checkout's dependency resolution.
import { tmpdir } from "node:os";
// oxlint-disable-next-line rules/no-node-imports -- Construct paths usable by the native child process and module resolver.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Load the isolated copy from its filesystem URL.
import { pathToFileURL } from "node:url";
import { matchesUndefined } from "#reylo-source/native-predicates.ts";
import { forEachFixtureInOrder } from "./helpers.ts";

// The native discovery tests change the process's actual override to exercise resolution.
export const overrideEnginePath = (filename?: string): (() => void) => {
  // oxlint-disable-next-line node/no-process-env -- The resolver under test reads the process's native override.
  const environment = process.env;
  const original = environment.REYLO_ENGINE_PATH;
  if (matchesUndefined(filename)) {
    delete environment.REYLO_ENGINE_PATH;
  } else {
    environment.REYLO_ENGINE_PATH = filename;
  }
  return () => {
    if (matchesUndefined(original)) {
      delete environment.REYLO_ENGINE_PATH;
    } else {
      environment.REYLO_ENGINE_PATH = original;
    }
  };
};

export const nativeTestDirectory = async (prefix: string): Promise<string> => mkdtemp(path.join(tmpdir(), prefix));
export const executable = process.platform === "win32" ? "reylo.exe" : "reylo";

export const legacyInstallation = async (root: string, profiles: string[]): Promise<URL> => {
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  const module = path.join(root, "src", "native.ts");
  await copyFile(new URL("../src/native.ts", import.meta.url), module);
  await forEachFixtureInOrder(profiles, async (profile) => {
    const location = path.join(root, "target", profile);
    await mkdir(location, { recursive: true });
    await writeFile(path.join(location, executable), "legacy local build");
  });
  return pathToFileURL(module);
};

export const configureProjectFile = async (root: string): Promise<void> => {
  await writeFile(path.join(root, ".reylo.yaml"), "direct_url: file:./app.db\n");
};

const EXECUTABLE_MODE = 0o755;

// Isolate the override and remove the stand-in after its child has stopped.
export const withEngine = async (body: string, run: (filename: string, root: string) => Promise<void>): Promise<void> => {
  const root = await nativeTestDirectory("reylo-native-test-");
  const filename = path.join(root, "reylo");
  await writeFile(filename, `#!/bin/sh\n${body}\n`);
  await chmod(filename, EXECUTABLE_MODE);
  const restore = overrideEnginePath(filename);
  try {
    await run(filename, root);
  } finally {
    restore();
    await rm(root, { force: true, recursive: true });
  }
};
