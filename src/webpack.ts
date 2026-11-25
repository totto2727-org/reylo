// A webpack-style loader, for webpack 5, Rspack and Next.js with Turbopack, which take loaders
// (not plugins) for a file type. Turbopack takes the same function as `reylo/turbopack`
// (`src/turbopack.ts`), so that each host's config names its own host:
//   Webpack / Rspack:  module.rules: [{ test: /\.sql$/, use: "reylo/webpack" }]
//   Turbopack:         turbopack: { rules: { "*.sql": { loaders: ["reylo/turbopack"], as: "*.js" } } }
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
import { tooling } from "./engine-package.ts";
import type { Tooling } from "./engine-package.ts";

type LoaderCallback = (error: Error | null, code?: string) => void;

interface LoaderContext {
  resourcePath: string;
  // oxlint-disable-next-line typescript/method-signature-style -- Loader hosts supply this method on their context object.
  addDependency(file: string): void;
  async: () => LoaderCallback;
}

type CompiledModule = Awaited<ReturnType<Tooling["sqlModule"]>>;

const compiledModule = async function compiledModule(resource: string, source: string): Promise<{ result: CompiledModule } | { error: Error }> {
  try {
    const engine = await tooling(path.dirname(resource));
    return { result: await engine.sqlModule(resource, source) };
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Forward the original rejection value to the loader's Error-typed callback.
    return { error: error as Error };
  }
};

const loadSql = async function loadSql(context: LoaderContext, source: string, complete: LoaderCallback): Promise<void> {
  const built = await compiledModule(context.resourcePath, source);
  if ("error" in built) {
    complete(built.error);
    return;
  }
  const { code, entry, watched } = built.result;
  // Rebuild when a migration, project file or environment file changes.
  Iterator.from([entry, ...watched]).forEach((file) => {context.addDependency(file);});
  // oxlint-disable-next-line unicorn/no-null -- Webpack's loader callback takes null when compilation succeeds.
  complete(null, code);
};

const loadWithCallback = function loadWithCallback(this: LoaderContext, source: string): void {
  const complete = this.async();
  // oxlint-disable-next-line eslint/no-void -- The host waits for its callback and requires a synchronous void return.
  void loadSql(this, source, complete);
};

// oxlint-disable-next-line import/no-default-export -- Webpack-family hosts load this entry point as their default loader.
export default function reyloSqlLoader(this: LoaderContext, source: string): void {
  // oxlint-disable-next-line oxc/no-this-in-exported-function -- The loader host provides the compilation context as this.
  loadWithCallback.call(this, source);
}
