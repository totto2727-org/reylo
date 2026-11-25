// The worker behind `src/bridge.ts` (`reylo/register`, `reylo/jest`): it builds a `.sql` file's
// Module, which can take a database round trip, while the loading thread blocks on `done`. It
// Loads the engine package's half only when asked (src/engine-package.ts), so that a failure to
// Load it is an answer and not a silent worker.
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to run the engine in the native worker channel.
import { parentPort } from "node:worker_threads";
// oxlint-disable-next-line rules/no-node-imports -- This worker locates the build engine relative to the project's SQL file.
import path from "node:path";
import { COMPLETE, SIGNAL_INDEX } from "./bridge-protocol.ts";
import type { SqlModuleReply, SqlModuleRequest } from "./bridge-protocol.ts";
import { tooling } from "./engine-package.ts";

const buildSql = async function buildSql(request: SqlModuleRequest): Promise<SqlModuleReply> {
  try {
    const engine = await tooling(path.dirname(request.path));
    const { code } = await engine.sqlModule(request.path, request.source);
    return { code };
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Serializing the engine's native Error preserves the worker protocol's message.
    return { error: (error as Error).message };
  }
};

const respond = async function respond(request: SqlModuleRequest): Promise<void> {
  const reply = await buildSql(request);
  const { port, done } = request;
  port.postMessage(reply);
  port.close();
  Atomics.store(done, SIGNAL_INDEX, COMPLETE);
  Atomics.notify(done, SIGNAL_INDEX);
};

// oxlint-disable-next-line typescript/no-non-null-assertion -- Only the native bridge starts this worker entry point, with its parent port.
parentPort!.on("message", (request: SqlModuleRequest) => {
  // oxlint-disable-next-line eslint/no-void -- The Node listener returns void and the reply travels through the requested port.
  void respond(request);
});
