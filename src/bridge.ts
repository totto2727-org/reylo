// A `.sql` file's module (`src/loader.ts`), answered synchronously, for the hosts that must answer
// At once while the analysis waits on the database: Node's load hook and Bun's plugin under
// `require()` (`src/register.ts`) and Jest's `process` (`src/jest.ts`). A worker thread analyzes
// (`src/register-worker.ts`) and this thread blocks until it answers, as SafeQL's ESLint rule does.
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to inspect or write files through the host filesystem.
import { readFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to run the engine in the native worker channel.
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

import { SIGNAL_INDEX, WAITING } from "./bridge-protocol.ts";
import type { SqlModuleRequest } from "./bridge-protocol.ts";
import { isRecord, matchesString } from "./native-predicates.ts";

interface WorkerState {
  worker?: Worker;
}

const workerState: WorkerState = {};
const WORKER_TIMEOUT_MS = 120_000;

const buildWorker = function buildWorker(): Worker {
  // The worker is this file's sibling, compiled (`.js`) or not (`.ts`).
  const extension = import.meta.url.slice(import.meta.url.lastIndexOf("."));
  workerState.worker ??= new Worker(new URL(`register-worker${extension}`, import.meta.url), { workerData: { reyloWorker: true } });
  workerState.worker.unref();
  return workerState.worker;
};

const unwrapReply = function unwrapReply(path: string, waited: string, reply: unknown): string {
  if (isRecord(reply)) {
    if ("error" in reply && matchesString(reply.error)) {
      // oxlint-disable-next-line rules/require-tagged-error -- Synchronous module hosts expect the worker's failure as a native Error.
      throw new Error(reply.error);
    }
    if (matchesString(reply.code)) {return reply.code;}
  }
  // oxlint-disable-next-line rules/require-tagged-error -- Report a stopped worker without loading Effect in the native module host.
  throw new Error(`${path}: reylo's worker ${waited === "timed-out" ? "did not answer in 120 s" : "ended without an answer"}.`);
};

const awaitReply = function awaitReply(path: string, worker: Worker): string {
  // oxlint-disable-next-line node/no-sync -- Jest and the native require hook need the SQL result before this call returns.
  const source = readFileSync(path, "utf8");
  const done = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const { port1, port2 } = new MessageChannel();
  // oxlint-disable-next-line eslint/sort-keys -- Keep the fields in the shared native message order.
  const request: SqlModuleRequest = { path, source, port: port2, done };
  worker.postMessage(request, [port2]);
  // The driver bounds analysis. This timeout only ends a wait on a worker that stopped.
  const waited = Atomics.wait(done, SIGNAL_INDEX, WAITING, WORKER_TIMEOUT_MS);
  const reply: unknown = receiveMessageOnPort(port1)?.message;
  port1.close();
  return unwrapReply(path, waited, reply);
};

export const sqlModuleSync = function sqlModuleSync(path: string): string {
  return awaitReply(path, buildWorker());
};
