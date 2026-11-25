// Supply the engine's catalog protocol directly from static Atlas HCL.
// oxlint-disable-next-line rules/no-node-imports -- Read the configured HCL file through the native host filesystem.
import { readFileSync } from "node:fs";
import { AnswerCache } from "./engine-core.ts";
import type { Analysis, EngineCore, EngineIo } from "./engine-core.ts";
import { sqliteSchemaFromHcl } from "./hcl-sqlite.ts";
import { nativeErrorText } from "./native-error-text.ts";
import { isEmptyArray } from "./native-predicates.ts";

// These are the two catalog requests defined by upstream engine/sqlite/src/sqlite.rs.
const DDL_QUERY = "select sql from sqlite_schema where sql is not null and type in ('table', 'view', 'index', 'trigger') order by rowid";
const FUNCTIONS_QUERY = "select name, narg, type from pragma_function_list";

interface StaticCatalog {
  analyze: (sql: string) => Promise<Analysis>;
  query: EngineIo["query"];
  forget: () => Promise<void>;
  close: () => Promise<void>;
}

const readStatements = (filename: string): string[] => {
  try {
    // oxlint-disable-next-line node/no-sync -- Build the static catalog from the file before exposing its synchronous factory.
    const source = readFileSync(filename);
    return sqliteSchemaFromHcl(source, filename);
  } catch (error) {
    // oxlint-disable-next-line rules/require-tagged-error -- Report the source path and preserve the native error cause.
    throw new Error(`Cannot evaluate HCL schema ${filename}: ${nativeErrorText(error, "message")}`, { cause: error });
  }
};

// oxlint-disable-next-line typescript/require-await -- The engine's describe contract returns a Promise, including on rejection.
const describe = async function describe(): Promise<never> {
  // oxlint-disable-next-line rules/require-tagged-error -- The static catalog retains its native invalid-request error.
  throw new Error("Static HCL analysis must not request a describe");
};

const staticQuery = (statements: string[]): EngineIo["query"] =>
  // oxlint-disable-next-line typescript/require-await -- Fulfil the asynchronous engine protocol from the already parsed catalog.
  async function query(sql, params) {
    if (!isEmptyArray(params)) {
      // oxlint-disable-next-line rules/require-tagged-error -- Preserve the native HCL catalog's invalid-parameter diagnostic.
      throw new Error("Static HCL catalog requests do not accept parameters.");
    }
    if (sql === DDL_QUERY) {return statements.map((statement) => [statement]);}
    // An empty function list instructs the native engine to use its embedded built-ins.
    if (sql === FUNCTIONS_QUERY) {return [];}
    // oxlint-disable-next-line rules/require-tagged-error -- The engine reports an unsupported static catalog request as a native error.
    throw new Error(`Unsupported static HCL catalog request: ${sql}`);
  };

/**
 * Open a static SQLite catalog for the given Atlas HCL file.
 * @param {string} filename - The project's static HCL file.
 * @param {EngineCore} engine - The native analyzer receiving the catalog responses.
 * @returns {StaticCatalog} The in-process catalog and its cache lifecycle.
 */
export const hclCatalog = function hclCatalog(filename: string, engine: EngineCore): StaticCatalog {
  const query = staticQuery(readStatements(filename));
  const io: EngineIo = { describe, query };
  const cache = new AnswerCache();
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the static catalog's established enumerable method order.
  return {
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the native analyzer's existing Promise to its callers.
    analyze: (sql) => engine.analyze(sql, "sqlite", io, cache),
    query,
    // oxlint-disable-next-line typescript/require-await -- The public lifecycle clears an in-memory cache before returning a fulfilled Promise.
    forget: async () => {cache.clear();},
    // oxlint-disable-next-line typescript/require-await -- The public lifecycle clears an in-memory cache before returning a fulfilled Promise.
    close: async () => {cache.clear();},
  };
};
