// A `.sql` file's module (`src/loader.ts`), answered synchronously, for the hosts that must answer
// At once while the analysis waits on the database: Node's load hook and Bun's plugin under
// `require()` (`src/register.ts`) and Jest's `process` (`src/jest.ts`). A worker thread analyzes
// (`src/register-worker.ts`) and this thread blocks until it answers, as SafeQL's ESLint rule does.
import { readFileSync } from "node:fs";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

let worker: Worker | undefined;

export function sqlModuleSync(path: string): string {
  // The worker is this file's sibling, compiled (`.js`) or not (`.ts`).
  const extension = import.meta.url.slice(import.meta.url.lastIndexOf("."));
  worker ??= new Worker(new URL(`./register-worker${extension}`, import.meta.url), { workerData: { reyloWorker: true } });
  worker.unref();
  const done = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ path, source: readFileSync(path, "utf8"), port: port2, done }, [port2]);
  // The analysis is bounded by the driver's own timeouts (10 s to connect); this one only ends the
  // Wait on a worker that died.
  const waited = Atomics.wait(done, 0, 0, 120_000);
  const reply = receiveMessageOnPort(port1)?.message as { code: string } | { error: string } | undefined;
  port1.close();
  if (!reply) {throw new Error(`${path}: reylo's worker ${waited === "timed-out" ? "did not answer in 120 s" : "ended without an answer"}.`);}
  if ("error" in reply) {throw new Error(reply.error);}
  return reply.code;
}
