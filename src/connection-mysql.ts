import { connectionField } from "./connection-unreachable.ts";

const NOT_MYSQL = Symbol.for("reylo.not-mysql");

/**
 * A build rejects MariaDB before analysis. Its prepare returns NULL parameter types and
 * LONGTEXT JSON columns, which would produce incorrect statement types.
 */
// oxlint-disable-next-line rules/require-tagged-error, unicorn/custom-error-definition -- Preserve the public class and its native Error behavior across tool and runtime bundles.
export class NotMysql extends Error {
  // oxlint-disable-next-line rules/no-readonly -- Preserve the existing error's immutable public brand.
  public readonly [NOT_MYSQL] = true;
  // oxlint-disable-next-line rules/no-readonly -- Preserve the existing error's read-only server name type.
  public readonly server: string;
  // oxlint-disable-next-line unicorn/custom-error-definition -- Existing callers see the inherited native name "Error".
  public constructor(server: string) {
    super(`the server is ${server}, not MySQL`);
    this.server = server;
  }
  public static [Symbol.hasInstance](value: unknown): boolean {
    return connectionField(value, NOT_MYSQL) === true;
  }
}
