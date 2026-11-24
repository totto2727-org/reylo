// Supply the engine's catalog protocol directly from static Atlas HCL, without a host database.
// oxlint-disable-next-line rules/no-node-imports -- This server-side entry point uses this built-in to inspect or write files through the host filesystem.
import { readFileSync } from "node:fs";
import { nativeErrorText } from "./native-error-text.ts";
import { sqliteSchemaFromHcl } from "./hcl-sqlite.ts";
import { AnswerCache } from './engine-core.ts';
import type { EngineCore, EngineIo } from './engine-core.ts';

// These are the two catalog requests defined by upstream engine/sqlite/src/sqlite.rs.
const DDL_QUERY = "select sql from sqlite_schema where sql is not null and type in ('table', 'view', 'index', 'trigger') order by rowid";
const FUNCTIONS_QUERY = "select name, narg, type from pragma_function_list";

export const hclCatalog = function hclCatalog(path: string, engine: EngineCore) {
  let statements: string[];
  try {
    statements = sqliteSchemaFromHcl(readFileSync(path), path);
  } catch (error) {
    throw new Error(`Cannot evaluate HCL schema ${path}: ${nativeErrorText(error, "message")}`, { cause: error });
  }
  const cache = new AnswerCache();
  const io: EngineIo = {
    describe: async () => { throw new Error("Static HCL analysis must not request a describe"); },
    query: async (sql, params) => {
      if (params.length !== 0) {throw new Error("Static HCL catalog requests do not accept parameters.");}
      if (sql === DDL_QUERY) {return statements.map((statement) => [statement]);}
      // No live target exists to enumerate. The engine's documented empty-list contract uses
      // Its embedded built-ins, not the functions of an unrelated host Node SQLite version.
      if (sql === FUNCTIONS_QUERY) {return [];}
      throw new Error(`Unsupported static HCL catalog request: ${sql}`);
    },
  };
  return {
    analyze: (sql: string) => engine.analyze(sql, "sqlite", io, cache),
    query: io.query,
    forget: async () => cache.clear(),
    close: async () => cache.clear(),
  };
};
