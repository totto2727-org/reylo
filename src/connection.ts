// A build can distinguish a failure to reach the server from a statement's own error.
import { connectionField } from "./connection-unreachable.ts";
import { matchesString } from "./native-predicates.ts";

export { NotMysql } from "./connection-mysql.ts";
export { reason, Unreachable } from "./connection-unreachable.ts";

const MYSQL_ACCESS_DENIED = 1045;
const LOGIN_FAILURES = ["28P01", "28000", "ER_ACCESS_DENIED_ERROR"];
const MARIADB_VERSION = /^(?:5\.5\.5-)?(?<release>\d+(?:\.\d+)*).*mariadb/iu;
const MARIADB_NAME = /mariadb/iu;

/**
 * Check whether the server rejected authentication before it described the statement.
 * @param {unknown} failure - A driver error, optionally wrapped with a cause.
 * @returns {boolean} Whether Postgres or MySQL reported a login failure.
 */
export const refusedLogin = function refusedLogin(failure: unknown): boolean {
  const source = connectionField(failure, "cause") ?? failure;
  return LOGIN_FAILURES.some((code) => connectionField(source, "code") === code) ||
    connectionField(source, "errno") === MYSQL_ACCESS_DENIED;
};

/**
 * Recognize MariaDB from the response to the version query.
 * @param {unknown} version - The raw driver value.
 * @returns {string | undefined} MariaDB and its release when present.
 */
export const notMysql = function notMysql(version: unknown): string | undefined {
  // oxlint-disable-next-line typescript/no-base-to-string -- Preserve how the version query coerces untyped native driver values.
  const text = String(version ?? "");
  const release = MARIADB_VERSION.exec(text)?.groups?.release;
  if (matchesString(release)) {return `MariaDB ${release}`;}
  return MARIADB_NAME.test(text) ? "MariaDB" : undefined;
};
