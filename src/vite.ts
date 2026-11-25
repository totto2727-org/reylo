// The Vite plugin, which is also a Rollup and a Rolldown plugin: one `load` hook that turns a
// `.sql` file into its module (`src/loader.ts`). `enforce: "pre"` runs it before Vite's own
// Asset handling; Rollup and Rolldown ignore the field.
//
// It resolves a relative `.sql` import itself too, before any other plugin's resolveId (`order:
// "pre"`, wherever it is listed): the Cloudflare Vite plugin (`@cloudflare/vite-plugin` 1.64) makes
// Every `.sql` import in a Worker an external text module in its own resolveId, so the import never
// Reached `load`, and `.run` was undefined on the string it gave (examples/cloudflare-workers).
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to inspect or write files through the host filesystem.
import { existsSync, readFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
import { releaseConnections, tooling } from "./engine-package.ts";
import { matchesUndefined } from "./native-predicates.ts";

/** What Vitest hands a plugin's `configureVitest`, as far as it is used here. */
interface VitestContext {
  // oxlint-disable-next-line typescript/method-signature-style -- Vitest supplies a host method with its own module type.
  defineCacheKeyGenerator?(generate: (module: { id: string }) => false | undefined): void;
  // oxlint-disable-next-line typescript/method-signature-style -- Vitest 4 supplies the same host method under this name.
  experimental_defineCacheKeyGenerator?(generate: (module: { id: string }) => false | undefined): void;
}

interface LoadContext {
  // oxlint-disable-next-line typescript/method-signature-style -- Bundler hooks supply this method on their context object.
  addWatchFile(id: string): void;
}

interface LoadedModule {
  code: string;
  map: null;
}

interface Plugin {
  name: string;
  enforce: "pre";
  resolveId: { order: "pre"; handler: typeof resolveSql };
  load: typeof loadSql;
  configureVitest: typeof configureVitest;
  buildEnd: typeof buildEnd;
}

// oxlint-disable-next-line unicorn/no-null -- Vite and Rollup use null for an unanswered hook or a source map absent from a transform.
const NO_RESULT = null;

const resolveSql = function resolveSql(source: string, importer: string | undefined): string | null {
  if (!source.endsWith(".sql") || matchesUndefined(importer)) {return NO_RESULT;}
  if (!source.startsWith("./") && !source.startsWith("../")) {return NO_RESULT;}
  // An importer may carry a query (`?v=…`) or be a virtual module, whose path is no directory.
  const from = importer.replace(/[?#].*$/u, "");
  if (!path.isAbsolute(from)) {return NO_RESULT;}
  const filename = path.resolve(path.dirname(from), source);
  // oxlint-disable-next-line node/no-sync -- The resolve hook returns its decision synchronously to every supported bundler.
  return existsSync(filename) ? filename : NO_RESULT;
};

const loadSql = async function loadSql(this: LoadContext, id: string): Promise<LoadedModule | null> {
  if (!id.endsWith(".sql")) {return NO_RESULT;}
  const engine = await tooling(path.dirname(id));
  // oxlint-disable-next-line node/no-sync -- Take the same uninterrupted source snapshot once the engine is ready for this build.
  const source = readFileSync(id, "utf8");
  const { code, entry, watched } = await engine.sqlModule(id, source);
  // Rebuild when a migration, project file or environment file changes.
  Iterator.from([entry, ...watched]).forEach((file) => {this.addWatchFile(file);});
  return { code, map: NO_RESULT };
};

const cacheKey = function cacheKey({ id }: { id: string }): false | undefined {
  return id.endsWith(".sql") ? false : undefined;
};

// Vitest keys its transform cache by source text. Reanalyze SQL when the schema or project
// Changes by declining to cache these modules. Vitest 4 uses the experimental hook name.
const configureVitest = function configureVitest(context: VitestContext): void {
  if (context.defineCacheKeyGenerator) {context.defineCacheKeyGenerator(cacheKey);}
  else {context.experimental_defineCacheKeyGenerator?.(cacheKey);}
};

const buildEnd = async function buildEnd(): Promise<void> {
  await releaseConnections();
};

// oxlint-disable-next-line import/no-default-export -- Existing bundler configs import the default plugin factory.
export default function reylo(): Plugin {
  // oxlint-disable-next-line eslint/sort-keys -- Keep the public plugin's hook and metadata enumeration order.
  return {
    name: "reylo",
    enforce: "pre",
    // oxlint-disable-next-line eslint/sort-keys -- Keep the ordered hook's public metadata before its handler.
    resolveId: { order: "pre", handler: resolveSql },
    load: loadSql,
    configureVitest,
    buildEnd,
  };
}
