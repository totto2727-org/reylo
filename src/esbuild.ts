// The esbuild plugin, which is also a Bun plugin: `Bun.build({ plugins })` and `Bun.plugin` take
// The same `setup(build)` object, with the same `onLoad` filter and the same `{ contents, loader }`
// Result. Bun's runtime plugin answers `import` through it; `require()` needs a synchronous
// Answer, which `reylo/register` gives.
// oxlint-disable-next-line rules/no-node-imports -- The standalone build hook reads SQL through its native Node or Bun host.
import { readFile } from "node:fs/promises";
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to resolve paths using the host platform's filesystem conventions.
import path from "node:path";
import { releaseConnections, tooling } from "./engine-package.ts";

interface LoadResult {
  contents: string;
  loader: "js";
  watchFiles?: string[];
}

interface Build {
  // oxlint-disable-next-line typescript/method-signature-style -- Node esbuild and Bun supply compatible host methods with different argument types.
  onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<LoadResult>): void;
  /** Esbuild's and Bun.build's; Bun's runtime plugin has none. */
  // oxlint-disable-next-line typescript/method-signature-style -- Node esbuild and Bun supply this optional host method.
  onEnd?(callback: () => Promise<void>): void;
}

interface Plugin {
  name: string;
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the public plugin method's variance for compatible build hosts.
  setup(build: Build): void;
}

const loadSql = async function loadSql(args: { path: string }): Promise<LoadResult> {
  const engine = await tooling(path.dirname(args.path));
  const source = await readFile(args.path, "utf8");
  const { code, entry, watched } = await engine.sqlModule(args.path, source);
  // Rebuild in watch mode when a migration, project file or environment file changes.
  return { contents: code, loader: "js", watchFiles: [entry, ...watched] };
};

const setup = function setup(build: Build): void {
  // oxlint-disable-next-line eslint/require-unicode-regexp -- Esbuild sends this filter's flags to Go's RE2, which rejects the JavaScript u flag.
  build.onLoad({ filter: /\.sql$/ }, loadSql);
  build.onEnd?.(releaseConnections);
};

// oxlint-disable-next-line import/no-default-export -- Existing Node and Bun build configs import the default plugin factory.
export default function reylo(): Plugin {
  return { name: "reylo", setup };
}
