// A child process that compiles statements on Cloudflare D1 as the project's wrangler runs it
// Locally, for src/sqlite-drivers.ts. It runs apart from the type check because wrangler and
// Workerd write to stdout, which is the content mapper's channel to TypeScript; its own stdout and
// Stderr go nowhere, and it answers over IPC.
//
// `getPlatformProxy` starts workerd with the bindings of the project's wrangler config. The first D1
// Binding, held in memory (`persist: false`) and never the remote database (`remoteBindings:
// False`: a binding marked `remote` would otherwise be the production database, and the schema
// Replayed into it), is given the type check's schema, so a statement compiles against the tables
// The analysis read; then each statement is compiled with EXPLAIN, which runs D1's checks (its
// Allowlist of functions is an authorizer SQLite calls while it compiles) without running the
// Statement.
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to convert local module URLs with the host platform's path rules.
import { pathToFileURL } from "node:url";
import { hasFunctionType, hasObjectType, isRecord, matchesNull, matchesString, matchesUndefined } from "./native-predicates.ts";

interface D1Statement {
  bind: (...values: unknown[]) => D1Statement;
  all: () => Promise<{ results: unknown[] }>;
  run: () => Promise<unknown>;
}
interface D1 {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<unknown>;
}
type Message = { kind: "schema"; ddl: string[] } | { kind: "explain"; id: number; sql: string; params: number } | { kind: "close" };

const FIRST_WORKER_ARGUMENT = 2;
const SUCCESS = 0;

const send = (message: object): boolean | undefined => process.send?.(message);
const [wrangler, directory] = process.argv.slice(FIRST_WORKER_ARGUMENT);
const workerPath = (value: string | undefined): string =>
  // oxlint-disable-next-line typescript/no-non-null-assertion -- The parent supplies both paths. Keep Node's own argument error when invoked without them.
  value!;
process.chdir(workerPath(directory));
const runtime: unknown = await import(pathToFileURL(workerPath(wrangler)).href);
if (!isRecord(runtime) || !hasFunctionType(runtime.getPlatformProxy)) {
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native TypeError that the child reports when an optional wrangler export cannot be called.
  throw new TypeError("getPlatformProxy is not a function");
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The worker loads wrangler from the consuming project and can only check the optional export at runtime.
const getPlatformProxy = runtime.getPlatformProxy as (options: { persist: boolean; remoteBindings: boolean }) =>
  Promise<{ env: Record<string, unknown>; dispose: () => Promise<void> }>;
const proxy = await getPlatformProxy({ persist: false, remoteBindings: false });
// oxlint-disable-next-line rules/no-type-predicate -- Independently installed Wrangler modules supply the native D1 binding. Its method shape narrows the external runtime value.
const isD1 = (binding: unknown): binding is D1 =>
  !matchesNull(binding) && (hasObjectType(binding) || hasFunctionType(binding)) &&
  "prepare" in binding && hasFunctionType(binding.prepare) &&
  "batch" in binding && hasFunctionType(binding.batch);
const db = Object.values(proxy.env).find((binding) => isD1(binding));
// oxlint-disable-next-line eslint/sort-keys -- Keep the parent worker's IPC response key order.
send({ kind: "ready", d1: !matchesUndefined(db) });

const ignoreReplayFailure = (): undefined => undefined;

const inOrder = async function <Value>(values: Iterable<Value>, step: (value: Value) => Promise<void>): Promise<void> {
  // oxlint-disable-next-line rules/no-for-loops -- D1 drops views before tables and waits for dependent DDL in source order.
  for (const value of values) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- A later statement must see all changes made by the preceding statement.
    await step(value);
  }
};

/**
 * Makes D1's schema the one given: what an earlier schema made is dropped (views first, then
 * tables, which take their indexes and triggers with them; a virtual table's shadow tables go
 * with it), then each statement runs, one at a time: a table D1 cannot make (a module its build
 * lacks) is left out, and a statement that reads it fails as it would on D1.
 * @param {D1} d1 - The in-memory Wrangler database.
 * @param {string[]} ddl - Schema statements in dependency order.
 */
const replay = async function (d1: D1, ddl: string[]): Promise<void> {
  const { results } = await d1
    .prepare("select type, name from sqlite_schema where type in ('view', 'table') and substr(name, 1, 7) <> 'sqlite_' and substr(name, 1, 4) <> '_cf_' order by type = 'table', rowid")
    .all();
  await inOrder(results, async (row) => {
    if (isRecord(row) && matchesString(row.type) && matchesString(row.name)) {
      const { type, name } = row;
      await d1.prepare(`drop ${type} if exists "${name.replaceAll('"', '""')}"`).run().catch(ignoreReplayFailure);
    }
  });
  await inOrder(ddl, async (statement) => {
    await d1.prepare(statement).run().catch(ignoreReplayFailure);
  });
};

// oxlint-disable-next-line unicorn/no-null -- D1 EXPLAIN binds real SQLite NULL for unused parameter values.
const EXPLAIN_SQL_NULL = null;

const disposeAndExit = async (): Promise<never> => {
  await proxy.dispose().catch(ignoreReplayFailure);
  // oxlint-disable-next-line unicorn/no-process-exit -- Explicitly end the worker after disposal so background Wrangler handles cannot keep it alive.
  return process.exit(SUCCESS);
};

const explain = async (d1: D1, message: Extract<Message, { kind: "explain" }>): Promise<void> => {
  try {
    await d1.prepare(`explain ${message.sql}`).bind(...Array.from({ length: message.params }, () => EXPLAIN_SQL_NULL)).all();
    // oxlint-disable-next-line eslint/sort-keys -- Keep the parent worker's IPC response key order.
    send({ kind: "explain", id: message.id });
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Wrangler rejects with a native diagnostic. Keep its supplied message and the original property-read behavior.
    const detail = (error as Error).message;
    // oxlint-disable-next-line eslint/sort-keys -- Keep the parent worker's IPC response key order.
    send({ kind: "explain", id: message.id, error: detail });
  }
};

const handle = async function (message: Message): Promise<void> {
  if (message.kind === "close" || !db) {
    await disposeAndExit();
  } else if (message.kind === "schema") {
    await replay(db, message.ddl).catch(ignoreReplayFailure);
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- IPC can carry an unsupported kind despite the parent-side message type.
  } else if (message.kind === "explain") {
    await explain(db, message);
  }
};

const processAfter = async (previous: Promise<void>, message: Message): Promise<void> => {
  await previous;
  await handle(message);
};

// Messages received while a replay is pending must wait for it before compiling.
const queue = { tail: Promise.resolve() };
process.on("message", (message: Message) => {
  queue.tail = processAfter(queue.tail, message);
});

process.on("disconnect", () => {
  // oxlint-disable-next-line eslint/no-void -- IPC disconnect has no awaiting caller. The worker exits after disposal completes or fails.
  void disposeAndExit();
});
