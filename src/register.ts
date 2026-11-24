// One preload for every runtime: `node --import reylo/register`, `nub --import reylo/register`,
// `bun --preload reylo/register` (or bunfig.toml). It is the build step for code that runs
// Unbundled: each `.sql` file becomes its module (`src/loader.ts`) as it loads, from `.reylo/` or
// The database. Node's load hook (module.registerHooks) and Bun's plugin under `require()` must
// Answer synchronously, while the analysis waits on the database, so they ask `src/bridge.ts`,
// Which blocks on a worker thread.
// oxlint-disable-next-line rules/no-node-imports -- The preload must recognize Reylo's native bridge worker.
import { workerData } from "node:worker_threads";
import { sqlModuleSync } from "./bridge.ts";

interface BunLoader {
  onLoad: (options: { filter: RegExp }, load: (args: { path: string }) => { contents: string; loader: string }) => void;
}

declare const Bun: undefined | {
  plugin: (plugin: { name: string; setup: (build: BunLoader) => void }) => void;
};

const isBridgeWorker = (data: unknown): boolean =>
  // oxlint-disable-next-line rules/force-predicate -- Initializing the preload must work without the optional Effect peer.
  typeof data === "object" && data !== null && "reyloWorker" in data && Boolean(data.reyloWorker);

const installNodeLoader = async (): Promise<void> => {
  const { registerHooks } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.endsWith(".sql")) {
        return nextLoad(url, context);
      }
      // oxlint-disable-next-line node/no-sync -- Node's synchronous module hook requires the complete SQL module before returning.
      const source = sqlModuleSync(fileURLToPath(url));
      return { format: "module", shortCircuit: true, source };
    },
  });
};

const installLoader = async (): Promise<void> => {
  // oxlint-disable-next-line rules/force-predicate -- typeof detects an absent Bun global on Node without importing the optional Effect peer.
  if (typeof Bun === "undefined") {
    await installNodeLoader();
    return;
  }
  Bun.plugin({
    name: "reylo-sql",
    setup(build) {
      build.onLoad({ filter: /\.sql$/u }, (args) => ({
        // oxlint-disable-next-line node/no-sync -- Bun's require hook requires the SQL module contents synchronously.
        contents: sqlModuleSync(args.path),
        loader: "js",
      }));
    },
  });
};

// The worker inherits the preload; it loads no `.sql` file itself.
if (!isBridgeWorker(workerData)) {
  await installLoader();
}
