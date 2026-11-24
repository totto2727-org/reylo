// Generated from the SQL by scripts/bun-example-types.ts.
import type { Query } from "@totto2727/reylo";
export type Params = { user_id: number; title: string; body?: string | null };
export type Row = { id: number; title: string };
export type QueryError = import("@totto2727/reylo").SqliteQueryError<{
  "SQLITE_CONSTRAINT": { columns: readonly ["body"] | readonly ["id"] | readonly ["rowid"] | readonly ["title"] | readonly ["user_id"]; table: "posts" };
  "SQLITE_CONSTRAINT_DATATYPE": { columns: readonly ["body"] | readonly ["id"] | readonly ["title"] | readonly ["user_id"]; table: "posts" };
  "SQLITE_CONSTRAINT_NOTNULL": { columns: readonly ["id"] | readonly ["title"] | readonly ["user_id"]; table: "posts" };
  "SQLITE_CONSTRAINT_PRIMARYKEY": { columns: readonly ["id"]; table: "posts" };
  "SQLITE_CONSTRAINT_ROWID": { columns: readonly ["rowid"]; table: "posts" };
}>;
export declare const sql: "insert into posts (user_id, title, body)\nvalues (?, ?, ?)\nreturning id, title";
export declare const raw: "insert into posts (user_id, title, body)\nvalues (:user_id, :title, :body)\nreturning id, title\n";
export declare const params: readonly ["user_id", "title", "body"];
/**
 * ```sql
 * insert into posts (user_id, title, body)
 * values (:user_id, :title, :body)
 * returning id, title
 * ```
 */
declare const query: Query<{ user_id: number; title: string; body?: string | null }, { id: number; title: string }, "one", "sqlite", QueryError> & {
  readonly sql: typeof sql;
  readonly raw: typeof raw;
  readonly source: string;
};
export default query;
