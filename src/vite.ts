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
import { dirname, isAbsolute, resolve } from "node:path";
import { releaseConnections, tooling } from "./engine-package.ts";
import { matchesUndefined } from "./native-predicates.ts";

/** What Vitest hands a plugin's `configureVitest`, as far as it is used here. */
type VitestContext = {
  defineCacheKeyGenerator?(generate: (module: { id: string }) => false | undefined): void;
  experimental_defineCacheKeyGenerator?(generate: (module: { id: string }) => false | undefined): void;
};

export default function reylo() {
  return {
    name: "reylo",
    enforce: "pre" as const,
    resolveId: {
      order: "pre" as const,
      handler(source: string, importer: string | undefined): string | null {
        if (!source.endsWith(".sql") || matchesUndefined(importer)) {return null;}
        if (!source.startsWith("./") && !source.startsWith("../")) {return null;}
        // An importer may carry a query (`?v=…`) or be a virtual module, whose path is no directory.
        const from = importer.replace(/[?#].*$/, "");
        if (!isAbsolute(from)) {return null;}
        const path = resolve(dirname(from), source);
        return existsSync(path) ? path : null;
      },
    },
    async load(this: { addWatchFile(id: string): void }, id: string) {
      if (!id.endsWith(".sql")) {return null;}
      const { code, entry, watched } = await (await tooling(dirname(id))).sqlModule(id, readFileSync(id, "utf8"));
      // A new analysis of the statement (the type check's, after a migration) rebuilds the module,
      // And so does a change to the project file or a `.env` file, which the module's text reads.
      Iterator.from([entry, ...watched]).forEach((file) => {this.addWatchFile(file);});
      return { code, map: null };
    },
    // Vitest keeps a transformed module across runs (`fsModuleCache`, on by default from Vitest
    // 5.0.5), keyed by its file's text, and in watch mode keeps its key until that file changes. A
    // `.sql` module changes with the analysis (a migration), the project file and `.env` as well,
    // And a key generator is synchronous where the module may wait on the database, so Vitest
    // Keeps none: `load` makes each one again, from `.reylo/` while the schema is unchanged.
    configureVitest(context: VitestContext) {
      const key = ({ id }: { id: string }) => (id.endsWith(".sql") ? false : undefined);
      // Vitest 4 has only the experimental name, which Vitest 5 keeps as a deprecated one.
      if (context.defineCacheKeyGenerator) {context.defineCacheKeyGenerator(key);}
      else {context.experimental_defineCacheKeyGenerator?.(key);}
    },
    async buildEnd() {
      await releaseConnections();
    },
  };
}
