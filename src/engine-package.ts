// Reylo's build-time half lives in the engine packages. Each one carries it as
// `@totto2727/reylo-<database>/tooling` (src/tooling.ts), so that reylo itself holds the run time and the
// Entry points a project names: the build steps, the preload's worker, the content mapper and the
// CLI. An entry point loads it the first time it runs, from the project's install first and then
// From reylo's own, as the engine itself is found (src/engine.ts). Every engine package carries the
// Same code at reylo's version, so the first one installed serves a project of any database.
//
// The path is resolved when it is needed and loaded with a `require` of it, which no bundler
// Follows. A bundler that reads this file (Turbopack bundles the webpack loader; webpack parses it
// For its build dependencies) follows an `import()` of a package's name, and fails the build where
// That engine is not installed; an `import()` of a computed URL, which tsc wraps in a helper of its
// Own, Turbopack reports as a module it cannot resolve. A `require` loads an ES module that has no
// Top-level await, which scripts/build.ts checks of each `tooling.js`.
// oxlint-disable-next-line rules/no-node-imports -- The native loader reads its own package version before resolving optional tooling.
import { readFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- Read metadata for an optional engine without blocking the asynchronous build step.
import { readFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the engine through the consumer's Node resolution context.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- Resolve package metadata against the host paths that Node returns.
import path from "node:path";
import { hasFunctionType, hasObjectType, matchesNull, matchesString } from "./native-predicates.ts";

/** What an engine package's build-time half offers reylo's entry points. */
export type Tooling = {
  /** The module a build step writes for a `.sql` file, and what the build watches: the `.reylo/` entry it was built from, and the project's files its text reads. */
  sqlModule(path: string, source: string): Promise<{ code: string; entry: string; watched: string[] }>;
  /** Closes every build step's connection, for a build that has ended. */
  releaseConnections: () => Promise<void>;
  /** The methods of TypeScript's content mapper protocol, which src/mapper.ts serves over this process's stdin and stdout. */
  mapperHandlers: () => Record<string, (params: unknown) => unknown | Promise<unknown>>;
  /** Runs the CLI's command, and answers with its exit code. */
  runCli(args: string[]): Promise<number>;
};

const PACKAGES = ["@totto2727/reylo-sqlite"];

const readVersion = (source: string): string | undefined => {
  const metadata: unknown = JSON.parse(source);
  return hasObjectType(metadata) && !matchesNull(metadata) && "version" in metadata &&
    matchesString(metadata.version) ? metadata.version : undefined;
};

// oxlint-disable-next-line node/no-sync -- Native require can load this module, so its package version must be read without top-level await.
const VERSION = readVersion(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const versionAt = async (manifest: string): Promise<string | undefined> => {
  try {
    return readVersion(await readFile(manifest, "utf8"));
  } catch {
    return undefined;
  }
};

const exportedTooling = (module: unknown): Tooling => {
  const value = hasObjectType(module) && !matchesNull(module) && "default" in module
    ? module.default
    : undefined;
  if (
    !hasObjectType(value) || matchesNull(value) ||
    !("mapperHandlers" in value) || !hasFunctionType(value.mapperHandlers) ||
    !("releaseConnections" in value) || !hasFunctionType(value.releaseConnections) ||
    !("runCli" in value) || !hasFunctionType(value.runCli) ||
    !("sqlModule" in value) || !hasFunctionType(value.sqlModule)
  ) {
    // oxlint-disable-next-line rules/require-tagged-error -- Report an invalid native tooling module through the build entry point.
    throw new TypeError("The installed Reylo engine does not export its build tooling.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The loader verifies the engine version and callable exports before using its own tooling contract.
  return value as Tooling;
};

let loaded: Promise<Tooling> | undefined = undefined;

const load = async function load(from: string): Promise<Tooling> {
  let other: { name: string; version: string | undefined; dir: string } | undefined;
  for (const base of [path.join(from, "package.json"), import.meta.url]) {
    const require = createRequire(base);
    for (const name of PACKAGES) {
      let toolingPath: string;
      try {
        toolingPath = require.resolve(`${name}/tooling`);
      } catch {
        // An engine package from before it carried this half has no such entry: its version says why.
        try {
          const manifest = require.resolve(`${name}/package.json`);
          other ??= { dir: path.dirname(manifest), name, version: await versionAt(manifest) };
        } catch {}
        continue;
      }
      const version = await versionAt(path.join(path.dirname(toolingPath), "package.json"));
      if (version !== VERSION) {
        other ??= { dir: path.dirname(toolingPath), name, version };
        continue;
      }
      // oxlint-disable-next-line import/no-dynamic-require -- Resolve the installed engine without forcing bundlers to include an optional package.
      const module: unknown = require(toolingPath);
      return exportedTooling(module);
    }
  }
  if (other) {throw new Error(`reylo ${VERSION} runs with ${other.name} ${VERSION}, and the one installed is ${other.version ?? "of no version"} (${other.dir}): npm install -D ${other.name}@${VERSION}`);}
  throw new Error(`reylo's SQLite/HCL build steps are not installed: npm install -D @totto2727/reylo-sqlite`);
};

/** The build-time half, as the project of the directory `from` finds it, or reylo's own install. */
export const tooling = function tooling(from: string = process.cwd()): Promise<Tooling> {
  if (!loaded) {
    const loading = load(from);
    // A failure is not kept: an engine may be installed while the process runs.
    loading.catch(() => {
      if (loaded === loading) {loaded = undefined;}
    });
    loaded = loading;
  }
  return loaded;
};

/** Closes the build steps' connections, where a build step has opened any. */
export const releaseConnections = async function releaseConnections(): Promise<void> {
  const loading = loaded;
  if (loading) {await (await loading.catch(() => undefined))?.releaseConnections();}
};
