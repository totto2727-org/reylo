// Generated from the SQL by scripts/native-example-types.ts.
declare module "*/get_user.sql" {
  import type { Query } from "#reylo-example-types";
  export type Params = { id: number };
  export type Row = { id: number; name: string };
  export type QueryError = import("#reylo-example-types").QueryError<"sqlite">;
  export const sql: "select id, name from users where id = ?";
  export const raw: "select id, name from users where id = :id\n";
  export const params: readonly ["id"];
  /**
   * ```sql
   * select id, name from users where id = :id
   * ```
   */
  const query: Query<{ id: number }, { id: number; name: string }, "maybeOne", "sqlite", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
  };
  export default query;
}
