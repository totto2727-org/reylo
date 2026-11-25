// oxlint-disable-next-line rules/no-node-imports -- Database addresses use the host platform's file path conventions.
import path from "node:path";
// oxlint-disable-next-line rules/no-node-imports -- Decode file URLs using the host platform's filesystem rules.
import { fileURLToPath } from "node:url";
import { isEmptyString, matchesUndefined } from "./native-predicates.ts";

export type Dialect = "postgres" | "sqlite" | "mysql" | "duckdb";

const HCL_SCHEME = "hcl:";
const MEMORY_DATABASE = ":memory:";

const urlDialects = new Map<string, Dialect>([
  ["duckdb", "duckdb"],
  ["file", "sqlite"],
  ["hcl", "sqlite"],
  ["mariadb", "mysql"],
  ["mysql", "mysql"],
  ["postgres", "postgres"],
  ["postgresql", "postgres"],
  ["sqlite", "sqlite"],
]);

/**
 * The dialect a URL's scheme names, or undefined for a scheme reylo does not read.
 * @param {string} url The database URL to inspect.
 * @returns {Dialect | undefined} The supported database dialect named by the URL.
 */
export const dialectOf = function dialectOf(url: string): Dialect | undefined {
  const scheme = /^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):/u.exec(url)?.groups?.scheme?.toLowerCase();
  return matchesUndefined(scheme) ? undefined : urlDialects.get(scheme);
};

/**
 * A single local Atlas HCL schema, never a database file or a remote source.
 * @param {string} url The database or HCL source URL.
 * @param {string} root The project directory for resolving a relative path.
 * @returns {string | undefined} The local HCL filename, if the URL names an HCL source.
 */
export const hclPath = function hclPath(url: string, root: string): string | undefined {
  if (!url.toLowerCase().startsWith(HCL_SCHEME)) {return undefined;}
  const source = url.slice(HCL_SCHEME.length);
  if (isEmptyString(source) || source.startsWith("//") || source.includes("?") || source.includes("#") || source.includes("\0") || !source.endsWith(".hcl")) {
    // oxlint-disable-next-line rules/require-tagged-error -- The synchronous native URL helper preserves the Error type and message used by callers.
    throw new Error("An hcl: source must name one local .hcl file, for example hcl:./schema.hcl.");
  }
  return path.resolve(root, source);
};

/**
 * `duckdb:./dev.duckdb`, `duckdb:///abs/dev.duckdb` → a path, relative ones resolved against baseDir; `duckdb::memory:` (or `duckdb:` alone) → `:memory:`, an empty database, for statements that read files alone.
 * @param {string} url The DuckDB address.
 * @param {string} baseDir The project directory for resolving relative files.
 * @returns {string} The database file or the native in-memory identifier.
 */
export const duckdbPath = function duckdbPath(url: string, baseDir: string): string {
  const stored = url.replace(/^[dD][uU][cC][kK][dD][bB]:(?:\/\/)?/u, "");
  if (isEmptyString(stored) || stored === MEMORY_DATABASE) {return MEMORY_DATABASE;}
  // On Windows, `duckdb:///C:/app.duckdb` names the drive, as a file URL does.
  const raw = process.platform === "win32" ? stored.replace(/^\/(?=[A-Za-z]:[\\/])/u, "") : stored;
  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
};

/**
 * `file:./dev.db`, `file:///abs/dev.db`, `sqlite:./dev.db`, `:memory:` → a path, relative ones resolved against baseDir.
 * @param {string} url The SQLite address.
 * @param {string} baseDir The project directory for resolving relative files.
 * @returns {string} The database file or the native in-memory identifier.
 */
export const sqlitePath = function sqlitePath(url: string, baseDir: string): string {
  if (url === MEMORY_DATABASE || url === "file::memory:") {return MEMORY_DATABASE;}
  const raw = url.startsWith("file://") ? fileURLToPath(url) : url.replace(/^(?:file|sqlite):(?:\/\/)?/u, "");
  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
};
