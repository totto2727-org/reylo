// Generated from the SQL by scripts/bun-example-types.ts.
import type { Query } from "@totto2727/reylo";
export type Params = { role: string };
export type Row = { id: number; title: string; body: string | null; author: string };
export type QueryError = import("@totto2727/reylo").SqliteQueryError<{}>;
export declare const sql: "select p.id, p.title, p.body, u.name as author\nfrom posts p\njoin users u on u.id = p.user_id\nwhere u.role = ?\norder by p.id";
export declare const raw: "select p.id, p.title, p.body, u.name as author\nfrom posts p\njoin users u on u.id = p.user_id\nwhere u.role = :role\norder by p.id\n";
export declare const params: readonly ["role"];
/**
 * ```sql
 * select p.id, p.title, p.body, u.name as author
 * from posts p
 * join users u on u.id = p.user_id
 * where u.role = :role
 * order by p.id
 * ```
 */
declare const query: Query<{ role: string }, { id: number; title: string; body: string | null; author: string }, "many", "sqlite", QueryError> & {
  readonly sql: typeof sql;
  readonly raw: typeof raw;
  readonly source: string;
};
export default query;
