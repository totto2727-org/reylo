// Generated from the SQL by scripts/bun-example-types.ts.
import type { Query } from "@totto2727/reylo";
export type Params = { id: number };
export type Row = { id: number; name: string; email: string | null; role: string; created_at: string };
export type QueryError = import("@totto2727/reylo").SqliteQueryError<{}>;
export declare const sql: "select id, name, email, role, created_at\nfrom users\nwhere id = ?";
export declare const raw: "select id, name, email, role, created_at\nfrom users\nwhere id = :id\n";
export declare const params: readonly ["id"];
/**
 * ```sql
 * select id, name, email, role, created_at
 * from users
 * where id = :id
 * ```
 */
declare const query: Query<{ id: number }, { id: number; name: string; email: string | null; role: string; created_at: string }, "maybeOne", "sqlite", QueryError> & {
  readonly sql: typeof sql;
  readonly raw: typeof raw;
  readonly source: string;
};
export default query;
