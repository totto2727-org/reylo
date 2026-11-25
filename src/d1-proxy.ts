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

const send = (message: object): boolean | undefined => process.send?.(message);
const [wrangler, dir] = process.argv.slice(2);
process.chdir(dir!);
const runtime: unknown = await import(pathToFileURL(wrangler!).href);
if (!isRecord(runtime) || !hasFunctionType(runtime.getPlatformProxy)) {
  // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native TypeError that the child reports when an optional wrangler export cannot be called.
  throw new TypeError("getPlatformProxy is not a function");
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The worker loads wrangler from the consuming project and can only check the optional export at runtime.
const getPlatformProxy = runtime.getPlatformProxy as (options: { persist: boolean; remoteBindings: boolean }) =>
  Promise<{ env: Record<string, unknown>; dispose: () => Promise<void> }>;
const proxy = await getPlatformProxy({ persist: false, remoteBindings: false });
const isD1 = (binding: unknown): binding is D1 =>
  !matchesNull(binding) && (hasObjectType(binding) || hasFunctionType(binding)) &&
  "prepare" in binding && hasFunctionType(binding.prepare) &&
  "batch" in binding && hasFunctionType(binding.batch);
const db = Object.values(proxy.env).find(isD1);
send({ kind: "ready", d1: !matchesUndefined(db) });

const ignoreReplayFailure = (): undefined => undefined;

/**
 * Makes D1's schema the one given: what an earlier schema made is dropped (views first, then
 * tables, which take their indexes and triggers with them; a virtual table's shadow tables go
 * with it), then each statement runs, one at a time: a table D1 cannot make (a module its build
 * lacks) is left out, and a statement that reads it fails as it would on D1.
 */
const replay = async function (d1: D1, ddl: string[]): Promise<void> {
  const { results } = await d1
    .prepare("select type, name from sqlite_schema where type in ('view', 'table') and substr(name, 1, 7) <> 'sqlite_' and substr(name, 1, 4) <> '_cf_' order by type = 'table', rowid")
    .all();
  for (const row of results) {
    if (isRecord(row) && matchesString(row.type) && matchesString(row.name)) {
      const { type, name } = row;
      // oxlint-disable-next-line eslint/no-await-in-loop -- The catalog orders views before tables, and each drop must finish before the next statement runs.
      await d1.prepare(`drop ${type} if exists "${name.replaceAll('"', '""')}"`).run().catch(ignoreReplayFailure);
    }
  }
  for (const statement of ddl) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Replay dependent schema statements in their original order and continue after unsupported DDL.
    await d1.prepare(statement).run().catch(ignoreReplayFailure);
  }
};

// oxlint-disable-next-line unicorn/no-null -- D1 EXPLAIN binds real SQLite NULL for unused parameter values.
const EXPLAIN_SQL_NULL = null;

const handle = async function (message: Message): Promise<void> {
  if (message.kind === "close" || !db) {
    await proxy.dispose().catch(ignoreReplayFailure);
    process.exit(0);
  }
  if (message.kind === "schema") {
    await replay(db, message.ddl).catch(ignoreReplayFailure);
  } else if (message.kind === "explain") {
    try {
      await db.prepare(`explain ${message.sql}`).bind(...Array.from({ length: message.params }, () => EXPLAIN_SQL_NULL)).all();
      send({ kind: "explain", id: message.id });
    } catch (error) {
      send({ kind: "explain", id: message.id, error: (error as Error).message });
    }
  }
};

// One message at a time, in the order they came: a new schema is in place before the statements
// Sent after it compile.
let queue = Promise.resolve();
process.on("message", (message: Message) => {
  queue = queue.then(() => handle(message));
});
process.on("disconnect", () => {
  void proxy.dispose().finally(() => process.exit(0));
});
