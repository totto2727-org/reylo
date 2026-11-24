// The esbuild plugin, which is also a Bun plugin: `Bun.build({ plugins })` and `Bun.plugin` take
// The same `setup(build)` object, with the same `onLoad` filter and the same `{ contents, loader }`
// Result. Bun's runtime plugin answers `import` through it; `require()` needs a synchronous
// Answer, which `reylo/register` gives.
// oxlint-disable-next-line rules/no-node-imports -- The standalone build hook reads SQL through its native Node or Bun host.
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { releaseConnections, tooling } from "./engine-package.ts";

type Build = {
  onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ contents: string; loader: "js"; watchFiles?: string[] }>): void;
  /** Esbuild's and Bun.build's; Bun's runtime plugin has none. */
  onEnd?(callback: () => Promise<void>): void;
};

export default function reylo() {
  return {
    name: "reylo",
    setup(build: Build) {
      // oxlint-disable-next-line eslint/require-unicode-regexp -- Esbuild sends this filter's flags to Go's RE2, which rejects the JavaScript u flag.
      build.onLoad({ filter: /\.sql$/ }, async (args) => {
        const { code, entry, watched } = await (await tooling(dirname(args.path))).sqlModule(args.path, await readFile(args.path, "utf8"));
        // In watch mode a new analysis of the statement (the type check's, after a migration)
        // Rebuilds the module, and so does a change to the project file or a `.env` file.
        return { contents: code, loader: "js", watchFiles: [entry, ...watched] };
      });
      build.onEnd?.(releaseConnections);
    },
  };
}
