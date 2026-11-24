// A webpack-style loader, for webpack 5, Rspack and Next.js with Turbopack, which take loaders
// (not plugins) for a file type. Turbopack takes the same function as `reylo/turbopack`
// (`src/turbopack.ts`), so that each host's config names its own host:
//   Webpack / Rspack:  module.rules: [{ test: /\.sql$/, use: "reylo/webpack" }]
//   Turbopack:         turbopack: { rules: { "*.sql": { loaders: ["reylo/turbopack"], as: "*.js" } } }
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to resolve paths using the host platform's filesystem conventions.
import { dirname } from "node:path";
import { tooling } from "./engine-package.ts";

interface LoaderContext {
  resourcePath: string;
  addDependency(file: string): void;
  async: () => (error: Error | null, code?: string) => void;
}

export default function reyloSqlLoader(this: LoaderContext, source: string): void {
  const done = this.async();
  tooling(dirname(this.resourcePath)).then((t) => t.sqlModule(this.resourcePath, source)).then(
    ({ code, entry, watched }) => {
      // A new analysis of the statement (the type check's, after a migration) rebuilds the module,
      // And so does a change to the project file or a `.env` file, which the module's text reads.
      Iterator.from([entry, ...watched]).forEach((file) => {this.addDependency(file);});
      done(null, code);
    },
    (error: Error) => done(error),
  );
}
