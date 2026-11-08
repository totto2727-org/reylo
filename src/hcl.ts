// Supply the engine's catalog protocol directly from static Atlas HCL, without a host database.
import { readFileSync } from "node:fs";
import { sqliteSchemaFromHcl } from "./hcl-sqlite.ts";
import { AnswerCache, type EngineCore, type EngineIo } from "./engine-core.ts";

// These are the two catalog requests defined by upstream engine/sqlite/src/sqlite.rs.
const DDL_QUERY = "select sql from sqlite_schema where sql is not null and type in ('table', 'view', 'index', 'trigger') order by rowid";
const FUNCTIONS_QUERY = "select name, narg, type from pragma_function_list";

export function hclCatalog(path: string, engine: EngineCore) {
  let statements: string[];
  try {
    statements = sqliteSchemaFromHcl(readFileSync(path), path);
  } catch (error) {
    throw new Error(`Cannot evaluate HCL schema ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cache = new AnswerCache();
  const io: EngineIo = {
    describe: async () => { throw new Error("Static HCL analysis must not request a describe"); },
    query: async (sql, params) => {
      if (params.length !== 0) throw new Error("Static HCL catalog requests do not accept parameters.");
      if (sql === DDL_QUERY) return statements.map((statement) => [statement]);
      // No live target exists to enumerate. The engine's documented empty-list contract uses
      // its embedded built-ins, not the functions of an unrelated host Node SQLite version.
      if (sql === FUNCTIONS_QUERY) return [];
      throw new Error(`Unsupported static HCL catalog request: ${sql}`);
    },
  };
  return {
    analyze: (sql: string) => engine.analyze(sql, "sqlite", io, cache),
    query: io.query,
    forget: async () => cache.clear(),
    close: async () => cache.clear(),
  };
}
