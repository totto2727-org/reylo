// The native parser and static Atlas adapter supply an analysis-only SQLite catalog.
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { sqliteSchemaFromHcl } from "./hcl-sqlite.ts";
import { AnswerCache, type EngineCore, type EngineIo } from "./engine-core.ts";

function sqliteInput(value: unknown): SQLInputValue {
  if (value === null || typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("SQLite catalog parameters must be null, numbers, bigints, strings or ArrayBuffer views.");
}

export function hclDatabase(path: string, engine: EngineCore) {
  let statements: string[];
  try {
    statements = sqliteSchemaFromHcl(readFileSync(path), path);
  } catch (error) {
    throw new Error(`Cannot evaluate HCL schema ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const db = new DatabaseSync(":memory:");
  try {
    // Prepare one statement at a time. SQL expression fields must not execute trailing
    // statements, even if a project supplies malformed SQL in an explicit expression.
    for (const sql of statements) {
      const statement = db.prepare(sql);
      // sqlite3_sql exposes exactly the text consumed by SQLite's own parser.
      // Do not silently accept trailing statements in an explicit SQL expression.
      if (statement.sourceSQL !== sql) throw new Error("Atlas SQLite SQL expression contains trailing statements.");
      statement.run();
      // SQLite omits a trailing comment from sqlite_schema.sql. Comparing its stored
      // DDL also catches an expression that comments out later constraints/options.
      const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid DESC LIMIT 1").get();
      if (stored?.sql !== sql) throw new Error("Atlas SQLite SQL expression truncates the declared schema.");
    }
    // Analysis asks only catalog queries. A replay must never mutate the schema it is reading.
    db.exec("PRAGMA query_only = ON");
  } catch (e) {
    db.close();
    throw new Error(`Cannot load HCL schema ${path} in memory: ${(e as Error).message}`);
  }
  const cache = new AnswerCache();
  const io: EngineIo = {
    describe: async () => { throw new Error("SQLite analysis must not request a describe"); },
    query: async (sql, params) => {
      const statement = db.prepare(sql);
      statement.setReturnArrays(true);
      // Node returns arrays here, but its typings still declare object rows after setReturnArrays.
      const rows: unknown = statement.all(...params.map(sqliteInput));
      if (!Array.isArray(rows)) throw new TypeError("SQLite catalog query did not return an array of rows.");
      return rows.map((row: unknown): unknown[] => {
        if (!Array.isArray(row)) throw new TypeError("SQLite catalog query did not return array rows.");
        return row;
      });
    },
  };
  return {
    analyze: (sql: string) => engine.analyze(sql, "sqlite", io, cache),
    query: io.query,
    forget: async () => cache.clear(),
    close: async () => db.close(),
  };
}
