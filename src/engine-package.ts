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
import { hasFunctionType, hasObjectType, matchesNull, matchesString, matchesUndefined } from "./native-predicates.ts";

/** What an engine package's build-time half offers reylo's entry points. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- Preserve structural assignment to the native tooling record.
export type Tooling = {
  /** The module a build step writes for a `.sql` file, and what the build watches: the `.reylo/` entry it was built from, and the project's files its text reads. */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the native tooling interface's method variance.
  sqlModule(path: string, source: string): Promise<{ code: string; entry: string; watched: string[] }>;
  /** Closes every build step's connection, for a build that has ended. */
  releaseConnections: () => Promise<void>;
  /** The methods of TypeScript's content mapper protocol, which src/mapper.ts serves over this process's stdin and stdout. */
  mapperHandlers: () => Record<string, (params: unknown) => unknown>;
  /** Runs the CLI's command, and answers with its exit code. */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the native tooling interface's method variance.
  runCli(args: string[]): Promise<number>;
};

const PACKAGE = "@totto2727/reylo-sqlite";

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

interface Incompatible { dir: string; name: string; version: string | undefined }
interface Search { other?: Incompatible }
interface Loading { pending?: Promise<Tooling> }

const state: Loading = {};

const resolveOptional = (resolver: NodeJS.Require, specifier: string): string | undefined => {
  try {
    return resolver.resolve(specifier);
  } catch {
    return undefined;
  }
};

const inspectOldPackage = async (resolver: NodeJS.Require, search: Search): Promise<void> => {
  // An older SQLite package may publish its manifest and omit the tooling entry.
  const manifest = resolveOptional(resolver, `${PACKAGE}/package.json`);
  if (!matchesUndefined(manifest) && matchesUndefined(search.other)) {
    search.other = { dir: path.dirname(manifest), name: PACKAGE, version: await versionAt(manifest) };
  }
};

const compatible = async (resolver: NodeJS.Require, entry: string, search: Search): Promise<Tooling | undefined> => {
  const dir = path.dirname(entry);
  const version = await versionAt(path.join(dir, "package.json"));
  if (version !== VERSION) {
    search.other ??= { dir, name: PACKAGE, version };
    return undefined;
  }
  const module: unknown = resolver(entry);
  return exportedTooling(module);
};

const find = async (base: string, search: Search): Promise<Tooling | undefined> => {
  const resolver = createRequire(base);
  const entry = resolveOptional(resolver, `${PACKAGE}/tooling`);
  if (matchesUndefined(entry)) {
    await inspectOldPackage(resolver, search);
    return undefined;
  }
  return compatible(resolver, entry, search);
};

const missing = (other: Incompatible | undefined): never => {
  if (!matchesUndefined(other)) {
    // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native version mismatch error shown on the CLI and in TypeScript.
    throw new Error(`reylo ${VERSION} runs with ${other.name} ${VERSION}, and the one installed is ${other.version ?? "of no version"} (${other.dir}): npm install -D ${other.name}@${VERSION}`);
  }
  // oxlint-disable-next-line rules/require-tagged-error -- Report the missing optional package without loading Effect.
  throw new Error(`reylo's SQLite/HCL build steps are not installed: npm install -D @totto2727/reylo-sqlite`);
};

const load = async (from: string): Promise<Tooling> => {
  const search: Search = {};
  const project = await find(path.join(from, "package.json"), search);
  if (!matchesUndefined(project)) {return project;}
  const installed = await find(import.meta.url, search);
  return installed ?? missing(search.other);
};

const loadWithRetry = async (from: string): Promise<Tooling> => {
  try {
    return await load(from);
  } catch (error) {
    // Clear a failed load so a package installed during the process can serve the next request.
    delete state.pending;
    throw error;
  }
};

/**
 * Resolve the matching engine in a project, then in Reylo's own install.
 * @param {string} [from] - The project's directory.
 * @returns {Promise<Tooling>} The shared loading operation.
 */
// oxlint-disable-next-line typescript/promise-function-async -- In-flight callers share the same Promise for the native tooling instance.
export const tooling = function tooling(from: string = process.cwd()): Promise<Tooling> {
  state.pending ??= loadWithRetry(from);
  return state.pending;
};

const loadedTooling = async (pending: Promise<Tooling>): Promise<Tooling | undefined> => {
  try {
    return await pending;
  } catch {
    return undefined;
  }
};

/** Closes the build steps' connections, where a build step has opened any. */
export const releaseConnections = async function releaseConnections(): Promise<void> {
  if (matchesUndefined(state.pending)) {return;}
  const ready = await loadedTooling(state.pending);
  await ready?.releaseConnections();
};
