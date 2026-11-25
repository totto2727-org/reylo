// Generated from the SQL by scripts/native-example-types.ts.
declare module "*/queries/create_post.sql" {
  import type { Query } from "#reylo-example-types";
  export type Params = { user_id: number; title: string; body?: string | null };
  export type Row = { id: number; title: string };
  export type QueryError = import("#reylo-example-types").SqliteQueryError<{
    "SQLITE_CONSTRAINT": { columns: readonly ["body"] | readonly ["id"] | readonly ["rowid"] | readonly ["title"] | readonly ["user_id"]; table: "posts" };
    "SQLITE_CONSTRAINT_DATATYPE": { columns: readonly ["body"] | readonly ["id"] | readonly ["title"] | readonly ["user_id"]; table: "posts" };
    "SQLITE_CONSTRAINT_NOTNULL": { columns: readonly ["id"] | readonly ["title"] | readonly ["user_id"]; table: "posts" };
    "SQLITE_CONSTRAINT_PRIMARYKEY": { columns: readonly ["id"]; table: "posts" };
    "SQLITE_CONSTRAINT_ROWID": { columns: readonly ["rowid"]; table: "posts" };
  }>;
  export const sql: "insert into posts (user_id, title, body)\nvalues (?, ?, ?)\nreturning id, title";
  export const raw: "insert into posts (user_id, title, body)\nvalues (:user_id, :title, :body)\nreturning id, title\n";
  export const params: readonly ["user_id", "title", "body"];
  /**
   * ```sql
   * insert into posts (user_id, title, body)
   * values (:user_id, :title, :body)
   * returning id, title
   * ```
   */
  const query: Query<{ user_id: number; title: string; body?: string | null }, { id: number; title: string }, "one", "sqlite", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
  };
  export default query;
}

declare module "*/queries/get_user.sql" {
  import type { Query } from "#reylo-example-types";
  export type Params = { id: number };
  export type Row = { id: number; name: string; email: string | null; role: string; created_at: string };
  export type QueryError = import("#reylo-example-types").SqliteQueryError<{}>;
  export const sql: "select id, name, email, role, created_at\nfrom users\nwhere id = ?";
  export const raw: "select id, name, email, role, created_at\nfrom users\nwhere id = :id\n";
  export const params: readonly ["id"];
  /**
   * ```sql
   * select id, name, email, role, created_at
   * from users
   * where id = :id
   * ```
   */
  const query: Query<{ id: number }, { id: number; name: string; email: string | null; role: string; created_at: string }, "maybeOne", "sqlite", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
  };
  export default query;
}

declare module "*/queries/list_posts.sql" {
  import type { Query } from "#reylo-example-types";
  export type Params = { role: string };
  export type Row = { id: number; title: string; body: string | null; author: string };
  export type QueryError = import("#reylo-example-types").SqliteQueryError<{}>;
  export const sql: "select p.id, p.title, p.body, u.name as author\nfrom posts p\njoin users u on u.id = p.user_id\nwhere u.role = ?\norder by p.id";
  export const raw: "select p.id, p.title, p.body, u.name as author\nfrom posts p\njoin users u on u.id = p.user_id\nwhere u.role = :role\norder by p.id\n";
  export const params: readonly ["role"];
  /**
   * ```sql
   * select p.id, p.title, p.body, u.name as author
   * from posts p
   * join users u on u.id = p.user_id
   * where u.role = :role
   * order by p.id
   * ```
   */
  const query: Query<{ role: string }, { id: number; title: string; body: string | null; author: string }, "many", "sqlite", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
  };
  export default query;
}
