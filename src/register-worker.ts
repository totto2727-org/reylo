// The worker behind `src/bridge.ts` (`reylo/register`, `reylo/jest`): it builds a `.sql` file's
// Module, which can take a database round trip, while the loading thread blocks on `done`. It
// Loads the engine package's half only when asked (src/engine-package.ts), so that a failure to
// Load it is an answer and not a silent worker.
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to run the engine in the native worker channel.
import { parentPort } from "node:worker_threads";
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to run the engine in the native worker channel.
import type { MessagePort } from "node:worker_threads";
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to resolve paths using the host platform's filesystem conventions.
import { dirname } from "node:path";
import { tooling } from "./engine-package.ts";

type Request = { path: string; source: string; port: MessagePort; done: Int32Array };

parentPort!.on("message", async ({ path, source, port, done }: Request) => {
  let reply: { code: string } | { error: string };
  try {
    reply = { code: (await (await tooling(dirname(path))).sqlModule(path, source)).code };
  } catch (error) {
    reply = { error: (error as Error).message };
  }
  port.postMessage(reply);
  port.close();
  Atomics.store(done, 0, 1);
  Atomics.notify(done, 0);
});
