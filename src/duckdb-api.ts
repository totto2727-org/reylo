// oxlint-disable-next-line rules/no-node-imports -- Resolve the project's own optional DuckDB driver through Node.
import { createRequire } from "node:module";
// oxlint-disable-next-line rules/no-node-imports -- Find the project's package descriptor using native paths.
import path from "node:path";
import { matchesUndefined } from "./native-predicates.ts";

/** The slice of `@duckdb/node-api` the type check uses. */
export interface NodeApi {
  DuckDBInstance: { create: (path?: string, options?: Record<string, string>) => Promise<Instance> };
  DuckDBTypeId: Record<number, string>;
  StatementType: Record<number, string>;
}
export interface Instance { connect: () => Promise<DbConnection>; closeSync: () => void }
export interface DbConnection {
  prepare: (sql: string) => Promise<Prepared>;
  runAndReadAll: (sql: string, values?: unknown[]) => Promise<{ getRowsJson: () => unknown[][] }>;
  closeSync: () => void;
}
export interface Prepared {
  statementType: number;
  parameterCount: number;
  parameterName: (index: number) => string;
  parameterTypeId: (index: number) => number;
  parameterType: (index: number) => NodeType;
  columnCount: number;
  columnName: (index: number) => string;
  columnType: (index: number) => NodeType;
  destroySync?: () => void;
}
export interface NodeType {
  typeId: number;
  alias?: string;
  toString: () => string;
  width?: number;
  scale?: number;
  valueType?: NodeType;
  length?: number;
  entryNames?: string[];
  entryTypes?: NodeType[];
  keyType?: NodeType;
  memberTags?: string[];
  memberTypes?: NodeType[];
  values?: string[];
}

/** Why the type check cannot read a DuckDB database: no `@duckdb/node-api` in the project. */
// oxlint-disable-next-line rules/require-tagged-error, unicorn/custom-error-definition -- Preserve the native analyzer error's public name without loading Effect.
export class NoDuckdbDriver extends Error {
  public constructor(root: string) {
    super(`DuckDB statements are typed on the project's own DuckDB, and ${root} has no @duckdb/node-api: npm install @duckdb/node-api`);
    this.name = "NoDuckdbDriver";
  }
}

const loaded = new Map<string, NodeApi>();

export const nodeApi = (root: string): NodeApi => {
  const known = loaded.get(root);
  if (!matchesUndefined(known)) {return known;}
  try {
    const require = createRequire(path.join(root, "package.json"));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This optional project's native package supplies the DuckDB methods used by the analyzer.
    const api = require("@duckdb/node-api") as NodeApi;
    loaded.set(root, api);
    return api;
  } catch {
    throw new NoDuckdbDriver(root);
  }
};
