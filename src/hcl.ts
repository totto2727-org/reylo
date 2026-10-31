// Atlas owns HCL parsing and evaluation. Reylo only hosts the resulting schema in memory.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AnswerCache, type EngineCore, type EngineIo } from "./engine-core.ts";

function sqliteInput(value: unknown): SQLInputValue {
  if (value === null || typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("SQLite catalog parameters must be null, numbers, bigints, strings or ArrayBuffer views.");
}

export function hclDatabase(path: string, engine: EngineCore) {
  const before = readFileSync(path, "utf8");
  const run = spawnSync("atlas", ["schema", "inspect", "--url", pathToFileURL(path).href, "--dev-url", "sqlite://dev?mode=memory", "--format", "{{ sql . }}"], {
    cwd: dirname(path), encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ATLAS_NO_UPDATE_NOTIFIER: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  if (run.error || run.status !== 0) throw new Error(`Cannot evaluate HCL schema ${path}: ${run.error?.message ?? (run.stderr.trim() || `Atlas exited with ${run.status ?? run.signal}`)}`);
  if (readFileSync(path, "utf8") !== before) throw new Error(`HCL schema ${path} changed while Atlas evaluated it. Retry the analysis.`);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(run.stdout);
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
