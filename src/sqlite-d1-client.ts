// oxlint-disable-next-line rules/no-node-imports -- Use the native IPC channel to launch the local wrangler worker.
import { fork } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Type the local process and its native IPC channel.
import type { ChildProcess } from "node:child_process";
// oxlint-disable-next-line rules/no-node-imports -- Read the installed wrangler's package metadata from the host.
import { existsSync, readFileSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- Walk the installed wrangler package using native paths.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the sibling IPC worker's URL to a Node subprocess path.
import { fileURLToPath } from "node:url";

const { dirname, join } = path;

/** How long workerd may take to start before D1 is left out. */
const D1_START = 30_000;

export interface D1Process {
  close: () => void;
  explain: (sql: string, params: number, ddl: string[]) => Promise<string | undefined>;
  // oxlint-disable-next-line rules/no-readonly -- The worker's version remains fixed for the lifetime of its connection.
  readonly version: string;
}

interface D1Ready {
  d1: boolean;
  kind: "ready";
}
type D1Reply = D1Ready | { kind: "explain"; id: number; error?: string };
type Replies = Map<number, (error: string | undefined) => void>;

interface D1Session {
  next: number;
  running: boolean;
  sent?: string;
}

const FIRST_REQUEST = 0;
const REQUEST_INCREMENT = 1;
const SHUTDOWN_GRACE = 2000;
const NO_REFUSAL = undefined;

const workerError = (message: string): Error => (
  // oxlint-disable-next-line rules/require-tagged-error -- Send a native Node subprocess error through the existing D1 startup boundary.
  new Error(message)
);

// oxlint-disable-next-line typescript/promise-function-async -- Give the startup race the native exit Promise without an intervening async completion.
const disconnected = (child: ChildProcess): Promise<never> => {
  const { promise, reject } = Promise.withResolvers<never>();
  child.once("exit", () => {reject(workerError("D1's process ended"));});
  return promise;
};

const refusalMessage = (error: string | undefined): string | undefined => {
  // D1 wraps SQLite's message: "D1_ERROR: no such function: x at offset 7: SQLITE_ERROR".
  const message = error?.replace(/^D1_ERROR: /u, "").replace(/ at offset \d+/u, "").replace(/: SQLITE_\w+$/u, "") ?? "";
  // A count of bindings D1 reads otherwise than the analysis is no refusal of the statement.
  return message && !message.startsWith("Wrong number of parameter bindings") ? message : NO_REFUSAL;
};

const repliesFrom = (child: ChildProcess, session: D1Session, ended: () => void): Replies => {
  const pending: Replies = new Map();
  // The channel keeps this process alive only while a statement waits on its answer, so a type
  // Check or a build ends when its own work does; the child ends with this process.
  child.on("message", (message: D1Reply) => {
    if (message.kind !== "explain") {return;}
    const settle = pending.get(message.id);
    if (settle) {settle(refusalMessage(message.error));}
    pending.delete(message.id);
    if (!pending.size) {child.channel?.unref();}
  });
  child.once("exit", () => {
    if (session.running) {ended();}
    pending.forEach((settle) => {settle(NO_REFUSAL);});
    pending.clear();
  });
  return pending;
};

const stopD1 = (child: ChildProcess): void => {
  if (child.connected) {child.send({ kind: "close" });}
  setTimeout(() => {child.kill();}, SHUTDOWN_GRACE).unref();
};

const waitForD1 = async (child: ChildProcess, gone: Promise<never>): Promise<void> => {
  const timeout = Promise.withResolvers<never>();
  setTimeout(() => {timeout.reject(workerError("workerd did not start"));}, D1_START).unref();
  const reply = Promise.withResolvers<D1Ready>();
  child.once("message", reply.resolve);
  const ready = await Promise.race([gone, timeout.promise, reply.promise]);
  if (!ready.d1) {throw workerError("the wrangler config binds no D1 database");}
};

const syncSchema = (child: ChildProcess, session: D1Session, ddl: string[]): void => {
  const text = JSON.stringify(ddl);
  if (text !== session.sent) {
    // oxlint-disable-next-line eslint/sort-keys -- The native IPC sender keeps the established schema field order.
    child.send({ kind: "schema", ddl });
    session.sent = text;
  }
};

const requestsTo = (child: ChildProcess, session: D1Session, pending: Replies): D1Process["explain"] =>
  async (sql, params, ddl) => {
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    if (child.connected) {
      const id = session.next;
      session.next += REQUEST_INCREMENT;
      pending.set(id, resolve);
      child.channel?.ref();
      syncSchema(child, session, ddl);
      // oxlint-disable-next-line eslint/sort-keys -- The native IPC sender keeps the established request field order.
      child.send({ kind: "explain", id, sql, params });
    } else {resolve(NO_REFUSAL);}
    return promise;
  };

const launchD1 = (entry: string, dir: string): ChildProcess => {
  const extension = import.meta.url.slice(import.meta.url.lastIndexOf("."));
  return fork(fileURLToPath(new URL(`d1-proxy${extension}`, import.meta.url)), [entry, dir], {
    // oxlint-disable-next-line node/no-process-env -- D1 inherits the host's Node environment through its local fork boundary.
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
};

/**
 * The installed wrangler's version, from the package.json above its entry point.
 * @param {string} entry - The installed wrangler entry point.
 * @returns {string} The version recorded in the package manifest.
 */
const wranglerVersion = function wranglerVersion(entry: string): string {
  const location = { dir: dirname(entry) };
  while (dirname(location.dir) !== location.dir) {
    const file = join(location.dir, "package.json");
    // oxlint-disable-next-line node/no-sync -- Resolve the selected package metadata in the same turn as starting its child.
    if (existsSync(file)) {
      // oxlint-disable-next-line node/no-sync -- Read the selected package version before starting its child in the same turn.
      const metadata: unknown = JSON.parse(readFileSync(file, "utf8"));
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node resolved the optional driver's package manifest with the standard npm name and version fields.
      const pkg = metadata as { name?: string; version?: string };
      if (pkg.name === "wrangler") {return pkg.version ?? "";}
    }
    location.dir = dirname(location.dir);
  }
  return "";
};

const connectHandlers = (child: ChildProcess, ended: () => void): { gone: Promise<never>; pending: Replies; session: D1Session } => {
  child.unref();
  const session: D1Session = { next: FIRST_REQUEST, running: false };
  const gone = disconnected(child);
  // oxlint-disable-next-line promise/prefer-await-to-then, eslint/no-empty-function -- Observe a child exit if startup terminates before the race can subscribe.
  gone.catch(() => {});
  return { gone, pending: repliesFrom(child, session, ended), session };
};

/**
 * Start the D1 child. Call `ended` when the child ends after it has started.
 * @param {string} entry - The installed wrangler entry point.
 * @param {string} dir - The project directory.
 * @param {() => void} ended - The callback for a child that leaves after startup.
 * @returns {Promise<D1Process>} The established local D1 connection.
 */
export const startD1 = async function startD1(entry: string, dir: string, ended: () => void): Promise<D1Process> {
  const version = wranglerVersion(entry);
  const child = launchD1(entry, dir);
  const { gone, pending, session } = connectHandlers(child, ended);
  try {
    await waitForD1(child, gone);
  } catch (error) {
    stopD1(child);
    throw error;
  }
  session.running = true;
  child.channel?.unref();
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the D1 connection's existing field order.
  return { version, close: () => {stopD1(child);}, explain: requestsTo(child, session, pending) };
};
