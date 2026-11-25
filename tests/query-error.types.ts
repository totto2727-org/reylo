// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Check the real Node SQLite driver type accepted by the native query API.
import type { DatabaseSync } from "node:sqlite";
import type { MysqlClient, MysqlCode, MysqlQueryError, PostgresClient, PostgresCondition, PostgresQueryError, Query, SqliteCode, SqliteQueryError } from '#reylo-source/index.ts';
import type { EmptyParameters } from "./helpers.ts";

type PostgresCase = Query<EmptyParameters, { id: number }, "one", "postgres">;
type MysqlCase = Query<EmptyParameters, never, "none", "mysql">;
type SqliteCase = Query<EmptyParameters, never, "none", "sqlite">;
type PgNarrowed = PostgresQueryError<{ "23505": { constraint: "users_email_key" | "users_pkey"; table: "users" } }>;
type MysqlNarrowed = MysqlQueryError<{ ER_DUP_ENTRY: { key: "users.PRIMARY" | "users.email" } }>;
type SqliteNarrowed = SqliteQueryError<{ SQLITE_CONSTRAINT_UNIQUE: { table: "posts"; columns: Readonly<["email"]> | Readonly<["slug", "lang"]> } }>;

// These functions type-check the public contract. The runner never calls them.
export const postgresTypes = async function (query: PostgresCase, client: PostgresClient): Promise<void> {
  const result = await query.try(client);
  if (result.error) {
    result.value satisfies undefined;
    result.error.condition satisfies PostgresCondition | undefined;
    assert.ok(result.error.code === "23505" || result.error.code === "P0001" || result.error.code === "U0001");
    // @ts-expect-error Postgres condition names come from the known server list.
    assert.ok(result.error.condition === "unique_violaton");
  } else {
    result.value.id satisfies number;
    result.error satisfies undefined;
  }
  result.value?.id satisfies number | undefined;
};

export const mysqlTypes = async function (query: MysqlCase, client: MysqlClient): Promise<void> {
  const result = await query.try(client);
  if (result.error) {
    result.error.code satisfies MysqlCode | undefined;
    result.error.errno satisfies number;
    // @ts-expect-error The misspelled code is not in MySQL's server list.
    assert.ok(result.error.code === "ER_DUP_ENTY");
  }
};

export const sqliteTypes = function (query: SqliteCase, client: DatabaseSync): void {
  // oxlint-disable-next-line node/no-sync -- The public contract has a synchronous SQLite entry point.
  const result = query.trySync(client);
  if (result.error) {
    result.error.code satisfies SqliteCode | undefined;
    // @ts-expect-error The misspelled code is not in SQLite's list.
    assert.ok(result.error.code === "SQLITE_CONSTRAINT_UNIQ");
  }
};

export const narrowedPostgresTypes = function (error: PgNarrowed): void {
  if (error.condition === "unique_violation") {
    error.code satisfies "23505";
    error.constraint satisfies "users_email_key" | "users_pkey" | undefined;
    // @ts-expect-error The statement cannot violate the posts constraint.
    assert.ok(error.constraint === "posts_pkey");
  } else {
    error.constraint satisfies string | undefined;
  }
  // @ts-expect-error The statement only raises server-defined codes.
  assert.ok(error.code === "U0001");
};

export const narrowedMysqlTypes = function (error: MysqlNarrowed): void {
  if (error.code === "ER_DUP_ENTRY") {
    error.key satisfies "users.PRIMARY" | "users.email" | undefined;
    // @ts-expect-error The statement does not write to posts.
    assert.ok(error.key === "posts.PRIMARY");
  }
};

export const narrowedSqliteTypes = function (error: SqliteNarrowed): void {
  if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
    error.columns satisfies Readonly<["email"]> | Readonly<["slug", "lang"]> | undefined;
    // @ts-expect-error The statement only writes to posts.
    assert.ok(error.table === "users");
  }
};
