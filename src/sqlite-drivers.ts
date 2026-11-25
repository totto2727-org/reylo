// The SQLite the app runs on. The type check prepares each statement in Reylo's own SQLite, but
// The app runs it on its driver's, which may be older or another engine: libSQL carries SQLite
// 3.45.1, which has no `json_pretty` and takes `iif` with three arguments or more. So each statement
// Is also prepared on every SQLite driver the project depends on that this Node can load, on a
// Read-only connection to the same database, and a driver that refuses it fails the type check
// With that SQLite's own message. Preparing compiles the statement without running it.
//
// A driver is the project's when its package.json lists it. One this Node cannot load (a native
// Module built for another Node) or that cannot open the database (Turso's engine refuses a
// Schema with an FTS5 table) is left out, as is bun:sqlite, which runs in another runtime.
//
// Cloudflare D1 is asked through the project's wrangler, which runs D1 locally: D1 refuses
// Functions its SQLite has (an allowlist it applies as SQLite compiles a statement, which nothing
// Lists: it refuses `pragma_function_list` too) and lacks others (FTS4, Geopoly), so the only way
// To know is to compile the statement there (src/d1-proxy.ts).
// oxlint-disable-next-line rules/no-node-imports -- Read package metadata during synchronous driver discovery.
import { existsSync, readFileSync, statSync } from "node:fs";
// oxlint-disable-next-line rules/no-node-imports -- Resolve the optional drivers from the consumer's Node package.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- Resolve consumer package and driver paths without loading Effect.
import { dirname, join } from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Compare statements with Node's built-in SQLite engine and its synchronous driver.
import { DatabaseSync } from "node:sqlite";
import { packageDir } from "./project.ts";
import { startD1 } from "./sqlite-d1-client.ts";
import type { D1Process } from "./sqlite-d1-client.ts";
import { nativeDrivers } from "./sqlite-native-drivers.ts";
import type { SqliteDriverOpener } from "./sqlite-native-drivers.ts";
import { matchesUndefined } from "./native-predicates.ts";

export interface SqliteDriver {
  /** The package the project lists. */
  readonly name: string;
  /** SQLite's message where it refuses to prepare `sql`, whose placeholders number `params`; undefined where it prepares it. */
  refuses(sql: string, params: number): Promise<string | undefined>;
  /** The error a refusal is: "@libsql/client runs SQLite 3.45.1, which refuses this statement: …". */
  says(refusal: string): string;
  close(): Promise<void>;
}

/**
 * The D1 child of each project, by wrangler and project directory, kept for the life of the
 * process: workerd takes a second or more to start, and a build step's session closes its
 * connection after each pause. A start that failed (a config that binds no D1 database, a workerd
 * that never started) is kept too, so it is not tried again on each connection; an edit of the
 * wrangler config (`config`) starts another child, and a child that ends after it started is
 * started again by the next connection.
 */
const d1s = new Map<string, { config: string; started: Promise<D1Process> }>();

/** The wrangler config files of the project in `dir`, as they are now: their names, sizes and times. */
const wranglerConfig = function (dir: string): string {
  return ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]
    .map((name) => {
      try {
        const { size, mtimeMs } = statSync(join(dir, name));
        return `${name} ${size} ${mtimeMs}`;
      } catch {
        return "";
      }
    })
    .join("\0");
};

/**
 * D1 as the project's wrangler runs it locally, in a child process (src/d1-proxy.ts), given the
 * schema of the database the type check reads. A project whose wrangler config binds no D1
 * database is not asked.
 */
async function openD1(require: NodeJS.Require, path: string): Promise<SqliteDriver> {
  const entry = require.resolve("wrangler");
  const dir = dirname(require.resolve("./package.json"));
  const key = `${entry}\0${dir}`;
  const config = wranglerConfig(dir);
  let held = d1s.get(key);
  if (held?.config !== config) {
    held?.started.then((driver) => driver.close(), () => {});
    const started = startD1(entry, dir, () => {
      if (d1s.get(key)?.started === started) {d1s.delete(key);}
    });
    started.catch(() => {});
    d1s.set(key, (held = { config, started }));
  }
  const d1 = await held.started;
  const schema = new DatabaseSync(path, { readOnly: true });
  return {
    name: "wrangler",
    says: (refusal) => `Cloudflare D1, as wrangler ${d1.version} runs it locally, refuses this statement: ${refusal}`,
    async refuses(sql, params) {
      // The schema is read for each statement, so D1 compiles it against the tables the analysis
      // Read, after a migration too.
      let ddl: string[];
      try {
        ddl = schemaDdl(schema);
      } catch {
        return undefined;
      }
      return d1.explain(sql, params, ddl);
    },
    async close() {
      schema.close();
    },
  };
}

/**
 * The schema as SQLite keeps it, in the order it was made, without SQLite's own tables, a virtual
 * table's shadow tables (its module makes them) and D1's `_cf_` tables (D1 refuses them).
 */
function schemaDdl(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `select s.sql from sqlite_schema s where s.sql is not null and substr(s.name, 1, 7) <> 'sqlite_' and substr(s.name, 1, 4) <> '_cf_'
         and not exists (select 1 from pragma_table_list p where p.name = s.name and p.type = 'shadow') order by s.rowid`,
      )
      .all() as { sql: string }[]
  ).map((r) => r.sql);
}

// Keep the order in which diagnostics list the optional drivers.
const DRIVERS: [string, SqliteDriverOpener][] = [...nativeDrivers, ["wrangler", openD1]];

/** The SQLite drivers the project's package.json lists, by package name. */
export function projectDrivers(root: string): string[] {
  const file = join(packageDir(root), "package.json");
  if (!existsSync(file)) {return [];}
  let listed: Set<string>;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string> | undefined>;
    listed = new Set(["dependencies", "devDependencies", "optionalDependencies"].flatMap((key) => Object.keys(pkg[key] ?? {})));
  } catch {
    return [];
  }
  return DRIVERS.map(([name]) => name).filter((name) => listed.has(name));
}

/** Opens each of the project's drivers on the database at `path`, read-only; one that cannot load or open it is left out. */
export async function openProjectDrivers(root: string, path: string): Promise<SqliteDriver[]> {
  if (path === ":memory:") {return [];}
  const names = projectDrivers(root);
  if (!names.length) {return [];}
  const require = createRequire(join(packageDir(root), "package.json"));
  const opened = await Promise.all(DRIVERS.filter(([name]) => names.includes(name)).map(([, open]) => open(require, path).catch(() => undefined)));
  return opened.filter((driver) => !matchesUndefined(driver));
}

const utf8 = new TextEncoder();
const START_OF_TEXT = 0;
const MIN_REPORTED_BYTES = 1;
const FIRST_MATCH = 0;

// oxlint-disable-next-line eslint/require-unicode-regexp -- Keep SQLite's ASCII case folding for named functions, including the original word character set.
const NAMED_FUNCTION = /(?:no such function|not authorized to use function): (?<functionName>[\w$]+)/i;
// oxlint-disable-next-line eslint/require-unicode-regexp -- Keep SQLite's ASCII case folding for named functions, including the original word character set.
const ARGUMENT_FUNCTION = /arguments to function (?<functionName>[\w$]+)\(\)/i;
const QUOTED_ERROR = /near "(?<text>[^"]+)"/u;

const escapeRefusal = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const refusalToken = (sql: string, message: string): { index: number; text: string } => {
  const functionName = NAMED_FUNCTION.exec(message)?.groups?.functionName ?? ARGUMENT_FUNCTION.exec(message)?.groups?.functionName;
  const quoted = QUOTED_ERROR.exec(message)?.groups?.text;
  const wanted = functionName ?? quoted;
  if (!matchesUndefined(wanted)) {
    const escaped = escapeRefusal(wanted);
    const source = matchesUndefined(functionName) ? escaped : `\\b${escaped}\\s*\\(`;
    // oxlint-disable-next-line eslint/require-unicode-regexp -- Match names and syntax text with the legacy case-insensitive behavior, including the ASCII word boundary.
    const match = new RegExp(source, "i").exec(sql);
    if (match) {return { index: match.index, text: wanted };}
  }
  return { index: sql.search(/\S/u), text: /\S+/u.exec(sql)?.[FIRST_MATCH] ?? "" };
};

/**
 * Where in the file a driver's refusal points: the call SQLite names ("no such function: x",
 * "wrong number of arguments to function x()", D1's "not authorized to use function: x"), else the text a syntax error is near, else the
 * statement's first word. In UTF-8 bytes, as the analysis's diagnostics are.
 * @param {string} sql - The original SQL statement.
 * @param {string} message - The driver's diagnostic message.
 * @returns {{ start: number, length: number }} The reported byte range.
 */
export const placeRefusal = function placeRefusal(sql: string, message: string): { start: number; length: number } {
  const { index, text } = refusalToken(sql, message);
  // oxlint-disable-next-line eslint/sort-keys -- Keep the diagnostic range's established field order.
  return { start: utf8.encode(sql.slice(START_OF_TEXT, Math.max(index, START_OF_TEXT))).length, length: Math.max(utf8.encode(text).length, MIN_REPORTED_BYTES) };
};
